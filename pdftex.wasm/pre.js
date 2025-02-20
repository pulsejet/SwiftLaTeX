const TEXCACHEROOT = "/pdftex";
const WORKROOT = "/work";

var Module = {};
self.memlog = "";
self.initmem = undefined;
self.mainfile = "main.tex";

/** @type {string} */
let texlive_endpoint = "https://texlive2.swiftlatex.com";

Module['print'] = function(a) {
    self.memlog += (a + "\n");
};

Module['printErr'] = function(a) {
    self.memlog += (a + "\n");
    console.log(a);
};

Module['postRun'] = function() {
    self.initmem = dumpHeapMemory();
    self.postMessage({ 'result': 'ok' });
};

Module['onAbort'] = function() {
    self.memlog += 'Engine crashed';
    self.postMessage({
        'result': 'failed',
        'status': -254,
        'log': self.memlog,
        'cmd': 'compile'
    });
    return;
};

function _allocate(content) {
    let res = _malloc(content.length);
    HEAPU8.set(new Uint8Array(content), res);
    return res;
}

function dumpHeapMemory() {
    var src = wasmMemory.buffer;
    var dst = new Uint8Array(src.byteLength);
    dst.set(new Uint8Array(src));
    return dst;
}

function restoreHeapMemory() {
    if (self.initmem) {
        var dst = new Uint8Array(wasmMemory.buffer);
        dst.set(self.initmem);
    }
}

/**
 * Write folder to FS recursively
 * @param {FileSystemDirectoryHandle} folder
 * @param {string} path
 */
async function prepareFS(folder, path) {
    if (folder === null) {
        const root = await self.navigator.storage.getDirectory();
        return await prepareFS(root, path);
    }

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

async function prepareExecutionContext() {
    self.memlog = '';
    restoreHeapMemory();

    // Prepare memory FS from OPFS.
    // When JSPI is available, hopefully WASMFS will be fast enough to be used
    // directly, and we can skip this step entirely.
    await prepareFS(null, '/');
}

async function compileLaTeXRoutine() {
    await prepareExecutionContext();

    // Set the main entry to compile
    cwrap('setMainEntry', 'number', ['string'])(self.mainfile);

    let status = ccall('compileLaTeX', 'number', [], []);
    if (status === 0) {
        let pdfArrayBuffer = null;
        _compileBibtex();
        try {
            const mainbasename = self.mainfile.split('.').slice(0, -1).join('.');
            const pdfurl = `${WORKROOT}/${mainbasename}.pdf`;
            pdfArrayBuffer = FS.readFile(pdfurl, { encoding: 'binary' });
        } catch (err) {
            console.error("Fetch content failed.");
            status = -253;
            self.postMessage({
                'result': 'failed',
                'status': status,
                'log': self.memlog,
                'cmd': 'compile'
            });
            return;
        }
        self.postMessage({
            'result': 'ok',
            'status': status,
            'log': self.memlog,
            'pdf': pdfArrayBuffer.buffer,
            'cmd': 'compile'
        }, [pdfArrayBuffer.buffer]);
    } else {
        console.error("Compilation failed, with status code " + status);
        self.postMessage({
            'result': 'failed',
            'status': status,
            'log': self.memlog,
            'cmd': 'compile'
        });
    }
}

function compileFormatRoutine() {
    prepareExecutionContext();
    let status = _compileFormat();
    if (status === 0) {
        let pdfArrayBuffer = null;
        try {
            let pdfurl = WORKROOT + "/pdflatex.fmt";
            pdfArrayBuffer = FS.readFile(pdfurl, {
                encoding: 'binary'
            });
        } catch (err) {
            console.error("Fetch content failed.");
            status = -253;
            self.postMessage({
                'result': 'failed',
                'status': status,
                'log': self.memlog,
                'cmd': 'compile'
            });
            return;
        }
        self.postMessage({
            'result': 'ok',
            'status': status,
            'log': self.memlog,
            'pdf': pdfArrayBuffer.buffer,
            'cmd': 'compile'
        }, [pdfArrayBuffer.buffer]);
    } else {
        console.error("Compilation format failed, with status code " + status);
        self.postMessage({
            'result': 'failed',
            'status': status,
            'log': self.memlog,
            'cmd': 'compile'
        });
    }
}

function mkdirRoutine(dirname) {
    try {
        //console.log("removing " + item);
        FS.mkdir(WORKROOT + "/" + dirname);
        self.postMessage({
            'result': 'ok',
            'cmd': 'mkdir'
        });
    } catch (err) {
        console.error("Not able to mkdir " + dirname);
        self.postMessage({
            'result': 'failed',
            'cmd': 'mkdir'
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

function writeFileRoutine(filename, content) {
    try {
        writeFileRecursive(`${WORKROOT}${filename}`, content, false);
        self.postMessage({
            'result': 'ok',
            'cmd': 'writefile'
        });
    } catch (err) {
        console.error("Unable to write file", err);
        self.postMessage({
            'result': 'failed',
            'cmd': 'writefile'
        });
    }
}

function setTexliveEndpoint(url) {
    texlive_endpoint = url || texlive_endpoint;
}

self['onmessage'] = function(ev) {
    let data = ev['data'];
    let cmd = data['cmd'];
    if (cmd === 'compilelatex') {
        compileLaTeXRoutine();
    } else if (cmd === 'compileformat') {
        compileFormatRoutine();
    } else if (cmd === "settexliveurl") {
        setTexliveEndpoint(data['url']);
    } else if (cmd === "mkdir") {
        mkdirRoutine(data['url']);
    } else if (cmd === "writefile") {
        writeFileRoutine(data['url'], data['src']);
    } else if (cmd === "setmainfile") {
        self.mainfile = data['url'];
    } else if (cmd === "grace") {
        console.error("Gracefully Close");
        self.close();
    } else if (cmd === "flushcache") {
        // cleanDir(WORKROOT);
    } else {
        console.error("Unknown command " + cmd);
    }
};

const texlive404_cache = new Set();
function kpse_find_file_impl(nameptr) {
    /** @type {string} */
    const filepath = UTF8ToString(nameptr);
    if (filepath.endsWith(".vf") || filepath.endsWith(".aux"))
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
