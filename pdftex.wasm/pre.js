var Module = {};

/** @type {string} Log from WASM */
let memlog = String();

/** @type {Uint8Array} Initialized WASM memory */
let initmem = undefined;

/** @type {string} TeXLive endpoint */
let texlive_endpoint = "https://texlive2.swiftlatex.com";

Module['print'] = function (a) {
    memlog += (a + "\n");
};

Module['printErr'] = function (a) {
    memlog += (a + "\n");
    console.warn(a);
};

Module['postRun'] = function () {
    dumpHeapMemory();
    self.postMessage({ 'result': 'ok' });
};

Module['onAbort'] = function () {
    memlog += 'Engine crashed';
    self.postMessage({
        'result': 'failed',
        'status': -254,
        'log': memlog,
        'cmd': 'compile'
    });
    return;
};

/**
 * Malloc inside WASM memory
 * @param {Uint8Array} content Content to allocate
 * @returns Pointer to the allocated memory
 */
function _allocate(content) {
    let res = _malloc(content.length);
    HEAPU8.set(new Uint8Array(content), res);
    return res;
}

/**
 * Dump the current heap memory
 * @returns {void}
 */
function dumpHeapMemory() {
    self.initmem = new Uint8Array(wasmMemory.buffer.byteLength);
    self.initmem.set(new Uint8Array(wasmMemory.buffer));
}

/**
 * Restore the heap memory from the initial state
 * @returns {void}
 */
function restoreHeapMemory() {
    if (self.initmem)
        new Uint8Array(wasmMemory.buffer).set(self.initmem);
}

/**
 * Write folders to FS recursively
 *
 * @param {FileSystemDirectoryHandle} folder
 * @param {string} path
 */
async function prepareFS(folder, path) {
    // Create folder if not exists
    if (!FS.analyzePath(path).exists)
        FS.mkdir(path);

    // Write files and folders recursively
    for await (const [name, handle] of folder.entries()) {
        if (handle instanceof FileSystemDirectoryHandle) {
            await prepareFS(handle, `${path}/${name}`);
        }
    }
}

/**
 * Prepare the execution context for the WASM engine
 */
async function prepareExecutionContext() {
    memlog = String();
    cleanupExecutionContext();

    // Prepare memory FS from OPFS.
    // When JSPI is available, hopefully WASMFS will be fast enough to be used
    // directly, and we can skip this step entirely.
    const root = await self.navigator.storage.getDirectory();
    await prepareFS(root, '/');
}

/**
 * Clear heap and cache memory
 */
function cleanupExecutionContext() {
    restoreHeapMemory();
    opfs404_cache.clear();
    opfsdir_cache.clear();
}

/**
 * Routine to compile the main TeX file
 * @param {string} workdir Working directory
 * @param {string} mainfile Main TeX file
 * @returns {void}
 */
async function compileLaTeXRoutine(workdir, mainfile) {
    let status = -253;

    try {
        await prepareExecutionContext();

        // Set the main entry to compile
        cwrap('setMainEntry', 'number', ['string', 'string'])(workdir, mainfile);

        // Compile LaTeX
        status = await ccall('compileLaTeX', 'number', [], [], { async: true });
        if (status !== 0) throw new Error("Compilation failed");

        // Compile Bibtex
        await ccall('compileBibtex', 'number', [], [], { async: true }); // allow failure (?)

        // Fetch the PDF file
        const mainbasename = mainfile.split('.').slice(0, -1).join('.');
        const pdfurl = `${workdir}/${mainbasename}.pdf`;
        const pdfArrayBuffer = FS.readFile(pdfurl, { encoding: 'binary' });

        self.postMessage({
            'result': 'ok',
            'status': status,
            'log': memlog,
            'pdf': pdfArrayBuffer.buffer,
            'cmd': 'compile'
        }, [pdfArrayBuffer.buffer]);
    } catch (err) {
        console.error(err);
        self.postMessage({
            'result': 'failed',
            'status': status,
            'log': `${memlog}\n${err}`,
            'cmd': 'compile'
        });
    } finally {
        cleanupExecutionContext();
    }
}

/**
 * Routine to compile the format
 * @returns {void}
 */
async function compileFormatRoutine() {
    let status = -253;

    try {
        await prepareExecutionContext();
        let status = _compileFormat();
        if (status !== 0) throw new Error("Format compilation failed");

        const formatUrl = `/pdflatex.fmt`;
        const formatBuffer = FS.readFile(formatUrl, { encoding: 'binary' });

        self.postMessage({
            'result': 'ok',
            'status': status,
            'log': memlog,
            'format': formatBuffer.buffer,
            'cmd': 'compile'
        }, [formatBuffer.buffer]);
    } catch (err) {
        console.error(err);
        self.postMessage({
            'result': 'failed',
            'status': status,
            'log': `${memlog}\n\n${err}`,
            'cmd': 'compile'
        });
    } finally {
        cleanupExecutionContext();
    }
}

/**
 * Write file to WASM memory FS recursively.
 * Optionally persist to OPFS.
 * @param {string} filename Full path of the file
 * @param {Uint8Array | string} content Content to write
 * @param {boolean} opfs Persist to OPFS
 */
function writeFileRecursive(filename, content, opfs) {
    if (typeof content === 'string') {
        content = new TextEncoder().encode(content);
    } else if (content instanceof Uint8Array) {
        // Do nothing
    } else {
        throw new Error("Invalid content type");
    }

    const c_content = _allocate(content);
    cwrap('wasmWriteFile', 'number', ['string', 'number', 'number'])
        (filename, c_content, content.length);

    if (opfs) {
        writeFileOpfsRecursive(filename, content).catch(console.error);
    }
}

/**
 * Write file to OPFS recursively
 * @param {string} filename Full path of the file
 * @param {Uint8Array} content File content
 */
async function writeFileOpfsRecursive(filename, content) {
    let folder = await self.navigator.storage.getDirectory();
    const parts = filename.split('/').filter(Boolean);
    for (let i = 0; i < parts.length - 1; i++) {
        folder = await folder.getDirectoryHandle(parts[i], { create: true });
    }

    const basename = parts[parts.length - 1];
    if (!basename) return;
    const file = await folder.getFileHandle(basename, { create: true });
    const writable = await file.createWritable();
    await writable.write(content);
    await writable.close();
}

/** Cache of errors from server */
const texlive404_cache = new Set();

/** Fetch a file from the network synchronously */
async function kpse_find_file_impl(nameptr) {
    /** @type {string} */
    const filepath = UTF8ToString(nameptr);
    if (filepath.endsWith(".vf") || filepath.endsWith(".aux") || filepath.includes("./"))
        return 0;
    if (texlive404_cache.has(filepath))
        return 0;

    const syncPtr = await kpse_sync_file_impl(0, filepath);
    if (syncPtr) return syncPtr; // synced from opfs

    // make the url conforming to the texlive endpoint
    const fileurlpath = filepath.replace("/__pdftex/", "/pdftex/");
    const basename = filepath.split('/').pop();
    if (!basename) return 0;

    notify_progress(`Downloading ${basename} from TeXLive`);
    const remote_url = `${texlive_endpoint}${fileurlpath}`;
    const response = await fetch(remote_url);
    notify_progress(null);

    if (!response.ok) {
        console.warn("TexLive download failed: " + remote_url);
        texlive404_cache.add(filepath);
        return 0;
    }

    const buffer = await response.arrayBuffer();
    writeFileRecursive(filepath, new Uint8Array(buffer), true);
    return _allocate(intArrayFromString(filepath));
}

/** Cache of errors from server */
const opfs404_cache = new Set();
const opfsdir_cache = new Map();

/**
 * Sync file from OPFS to WASM memory FS
 *
 * @param {number} cwdptr Current working directory
 * @param {number|string} nameptr File name
 *
 * @returns {Promise<number>} path pointer if file is synced, 0 otherwise
 */
async function kpse_sync_file_impl(cwdptr, nameptr) {
    const cwd = cwdptr ? UTF8ToString(cwdptr) : null;
    const name = typeof nameptr === "string" ? nameptr : UTF8ToString(nameptr)

    let path = name;
    if (!name.startsWith("/") && cwd) {
        path = `${cwd}/${name}`;
    }

    if (opfs404_cache.has(path))
        return 0;

    try {
        const parts = path.split('/').filter(Boolean);

        // Resolve . and .. in path
        for (let i = 0; i < parts.length; i++) {
            if (parts[i] === ".") {
                parts.splice(i, 1);
                i--;
            } else if (parts[i] === "..") {
                if (i === 0) throw new Error("Invalid file name");
                parts.splice(i - 1, 2);
                i -= 2;
            }
        }

        // Check directory cache
        const dirpath = parts.slice(0, -1).join('/');
        let folder = opfsdir_cache.get(dirpath);

        // Get the directory from OPFS
        if (!folder) {
            folder = await self.navigator.storage.getDirectory();
            for (let i = 0; i < parts.length - 1; i++) {
                folder = await folder.getDirectoryHandle(parts[i], { create: false });
                if (!folder) throw new Error("Directory not found");
            }

            // Cache the directory
            opfsdir_cache.set(dirpath, folder);
        }

        // Get the file from OPFS
        const basename = parts[parts.length - 1];
        if (!basename) throw new Error("Invalid file name");

        const file = await folder.getFileHandle(basename, { create: false });
        if (!file) throw new Error("File not found");

        // Write the file to WASM memory FS
        const content = await file.getFile();
        const buffer = await content.arrayBuffer();
        writeFileRecursive(path, new Uint8Array(buffer), false);

        if (path.startsWith(cwd))
            return _allocate(intArrayFromString(path));
        else
            return _allocate(intArrayFromString(path));
    } catch (err) {
        opfs404_cache.add(name);
        return 0;
    }
}

/**
 * Notify the progress of the compilation
 * @param {string|null} status Status message
 */
function notify_progress(status) {
    self.postMessage({ 'cmd': 'progress', 'status': status });
}

self.onmessage = function (event) {
    const data = event.data;
    const cmd = data.cmd;

    if (cmd === 'compilelatex') {
        compileLaTeXRoutine(data.workdir, data.mainfile);
    } else if (cmd === 'compileformat') {
        compileFormatRoutine();
    } else if (cmd === "settexliveurl") {
        texlive_endpoint = data.url || texlive_endpoint;
    } else if (cmd === "close") {
        self.close();
    } else {
        console.error("Unknown command " + cmd);
    }
};
