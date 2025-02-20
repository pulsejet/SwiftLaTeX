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
 * Write folder to FS recursively
 * @param {FileSystemDirectoryHandle} folder
 * @param {string} path
 */
async function prepareFS(folder, path) {
    // Create folder if not exists
    if (!FS.analyzePath(path).exists)
        FS.mkdir(path);

    // Write files and folders recursively
    for await (const [name, handle] of folder.entries()) {
        const filepath = `${path}/${name}`;

        if (handle instanceof FileSystemFileHandle) {
            const content = await handle.getFile();

            // Skip if file exists and not modified
            if (FS.analyzePath(filepath).exists && content.lastModified <= (FS.stat(filepath)?.mtime ?? 0))
                continue;

            const bytes = await content.arrayBuffer();
            FS.writeFile(filepath, new Uint8Array(bytes));
            FS.utime(filepath, content.lastModified, content.lastModified);
        } else if (handle instanceof FileSystemDirectoryHandle) {
            await prepareFS(handle, filepath);
        }
    }
}

/**
 * Prepare the execution context for the WASM engine
 */
async function prepareExecutionContext() {
    memlog = String();
    restoreHeapMemory();

    // Prepare memory FS from OPFS.
    // When JSPI is available, hopefully WASMFS will be fast enough to be used
    // directly, and we can skip this step entirely.
    const root = await self.navigator.storage.getDirectory();
    await prepareFS(root, '/');
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

        // Change to the working directory
        FS.chdir(workdir);

        // Set the main entry to compile
        cwrap('setMainEntry', 'number', ['string'])(mainfile);

        // Compile LaTeX
        status = ccall('compileLaTeX', 'number', [], []);
        if (status !== 0) throw new Error("Compilation failed");

        // Compile Bibtex
        ccall('compileBibtex', 'number', [], []); // allow failure (?)

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

        FS.chdir('/');
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
    } else if (content instanceof ArrayBuffer || content instanceof Uint8Array) {
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
function kpse_find_file_impl(nameptr) {
    /** @type {string} */
    const filepath = UTF8ToString(nameptr);
    if (filepath.endsWith(".vf") || filepath.endsWith(".aux") || filepath.includes("./"))
        return 0;
    if (texlive404_cache.has(filepath))
        return 0;

    const remote_url = `${texlive_endpoint}${filepath}`;
    let xhr = new XMLHttpRequest();
    xhr.open("GET", remote_url, false);
    xhr.timeout = 150000;
    xhr.responseType = "arraybuffer";

    try {
        xhr.send();
    } catch (err) {
        console.warn("TexLive download failed: " + remote_url);
        return 0;
    }

    if (xhr.status === 200) {
        writeFileRecursive(filepath, new Uint8Array(xhr.response), true);
        return _allocate(intArrayFromString(filepath));
    } else if (xhr.status === 301) {
        console.warn("TexLive file not exists " + remote_url);
        texlive404_cache.add(filepath);
        return 0;
    }

    return 0;
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
