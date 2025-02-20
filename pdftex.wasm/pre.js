const TEXCACHEROOT = "/pdftex";
const WORKROOT = "/work";
const OPFS_PREFIX = "/opfs";

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

function prepareExecutionContext() {
    self.memlog = '';
    restoreHeapMemory();
}

function cleanDir(dir) {
    let l = FS.readdir(dir);
    for (let i in l) {
        let item = l[i];
        if (item === "." || item === "..") {
            continue;
        }
        item = dir + "/" + item;
        let fsStat = undefined;
        try {
            fsStat = FS.stat(item);
        } catch (err) {
            console.error("Not able to fsstat " + item);
            continue;
        }
        if (FS.isDir(fsStat.mode)) {
            cleanDir(item);
        } else {
            try {
                FS.unlink(item);
            } catch (err) {
                console.error("Not able to unlink " + item);
            }
        }
    }

    if (dir !== WORKROOT) {
        try {
            FS.rmdir(dir);
        } catch (err) {
            console.error("Not able to top level " + dir);
        }
    }
}

function compileLaTeXRoutine() {
    prepareExecutionContext();

    // Set the main entry to compile
    cwrap('setMainEntry', 'number', ['string'])(self.mainfile);

    let status = ccall('compileLaTeX', 'number', [], []);
    if (status === 0) {
        let pdfArrayBuffer = null;
        _compileBibtex();
        try {
            let pdfurl = WORKROOT + "/" + self.mainfile.substr(0, self.mainfile.length - 4) + ".pdf";
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

function writeFileRecursive(filename, content) {
    const parts = filename.substring(0, filename.lastIndexOf("/")).split("/");
    let current = String();
    for (let i = 0; i < parts.length; i++) {
        current += "/" + parts[i];
        if (!FS.analyzePath(current).exists) {
            FS.mkdir(current);
        }
    }
    FS.writeFile(filename, content);
}

function writeFileRoutine(filename, content) {
    try {
        writeFileRecursive(`${OPFS_PREFIX}${WORKROOT}${filename}`, content);
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
        cleanDir(WORKROOT);
    } else {
        console.error("Unknown command " + cmd);
    }
};

const texlive404_cache = new Set();
function kpse_find_file_impl(nameptr, format, _mustexist) {
    const reqname = UTF8ToString(nameptr);
    if (reqname.includes("/"))
        return 0;
    if (reqname.endsWith(".vf") || reqname.endsWith(".aux"))
        return 0;

    const filepath = `${TEXCACHEROOT}/${format}/${reqname}`;
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
        console.log("TexLive Download Failed " + remote_url);
        return 0;
    }

    if (xhr.status === 200) {
        writeFileRecursive(OPFS_PREFIX + filepath, new Uint8Array(xhr.response));
        return _allocate(intArrayFromString(OPFS_PREFIX + filepath));
    } else if (xhr.status === 301) {
        console.warn("TexLive File not exists " + remote_url);
        texlive404_cache.add(filepath);
        return 0;
    }
    return 0;
}

function kpse_find_pk_impl(nameptr, dpi) {
    const reqname = UTF8ToString(nameptr);
    if (reqname.includes("/"))
        return 0;
    if (reqname.endsWith(".vf") || reqname.endsWith(".aux"))
        return 0;

    const filepath = `${TEXCACHEROOT}/pk/${dpi}/${reqname}`;
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
        console.log("TexLive Download Failed " + remote_url);
        return 0;
    }

    if (xhr.status === 200) {
        writeFileRecursive(OPFS_PREFIX + filepath, new Uint8Array(xhr.response));
        return _allocate(intArrayFromString(OPFS_PREFIX + filepath));
    } else if (xhr.status === 301) {
        console.log("TexLive File not exists " + remote_url);
        texlive404_cache.add(filepath);
        return 0;
    }

    return 0;

}