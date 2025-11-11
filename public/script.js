'use strict';
const c = document.getElementById("canvas");
const c2 = document.createElement("canvas");
const q = c.getContext("2d");
const q2 = c2.getContext("2d", {willReadFrequently: true});
const ta = document.getElementById("ta");
const m = document.getElementById("modal");
const co = document.getElementById("coords");
const grid = document.getElementById("grid");
const link = document.getElementById("placeholderlink");
const zoomElm = document.getElementById("zoom");
var tiles = {/*
    "0,1": {
        content: " ".repeat(112) + "suggestion",
        properties: {links: {113: {type: "url", url: "test"}}}, redraw: true
    },
    "1,0": {
        content: "abcd".repeat(32),
        properties: {
            prot: [0xffffffff, 0xf00f0ff1, 0xffffffff, 0xffffffff]
        }, redraw: true
    }*/
};
const tileRenders = {};
var loading = [];
var queuedWrites = {};
var queuedWritesChars = {};
const styles = {};
const client = {
    chunkSize: [16, 8],
    charSize: [10, 20],
    fontSize: 20,
    pasteLimit: 200,
    isAdmin: false
};
const cl = {
    ch: client.chunkSize,
    cr: client.charSize
}
const pan = [0, 0];
const prevMousePos = [0, 0];
const zooms = [.2, .35, .5, .75, 1, 1.25, 1.5, 1.6, 1.75, 2, 2.5, 3, 4];
const maxPasteLimit = 500;
const placeholderChange = {};
const placeholderStates = {};
var socket = {send: () => {}};
var lineX = [0, 0];
var cursorCoords = [0, 0, 0, 0];
var zoomAt = 4;
var panning = false;
var zoom = 1;
var update = 1;
var charCount = 1;
var lastPaste = 0;
var doing = "";
var toProt = [];
var online;
function resize() {
    c.width = innerWidth;
    c.height = innerHeight;
    update = 1;
}
addEventListener("resize", resize);
resize();
function onClientChange() {
    c2.width = cl.ch[0] * cl.cr[0] * zoom;
    c2.height = cl.ch[1] * cl.cr[1] * zoom;
}
onClientChange();
function frame() {
    if(update) {
        if(Object.keys(tiles).length > 3000) clearUnseenTiles();
        q.clearRect(0, 0, c.width, c.height);
        const center = [c.width >> 1, c.height >> 1];
        const tilesToLoad = [];
        getVisibleChunks().forEach(function(pos) {
            if(!tiles[pos]) {
                if (!loading.includes(pos) && socket.readyState === socket.OPEN) {
                    tilesToLoad.push(pos);
                    loading.push(pos);
                }
                return;
            }
            if(tiles[pos].redraw) drawTile(pos);
            let [tx, ty] = pos.split(",");
            tx = parseInt(tx);
            ty = parseInt(ty);
            const [x, y] = [
                tx * cl.ch[0] * cl.cr[0] * zoom - Math.floor(pan[0]) + center[0],
                ty * cl.ch[1] * cl.cr[1] * zoom - Math.floor(pan[1]) + center[1],
            ];
            if(tileRenders[pos]) q.putImageData(tileRenders[pos], x, y);
        });
        if(tilesToLoad.length) send({kind: "tiles", tiles: tilesToLoad}, socket);
        if(cursorCoords) co.innerHTML = online + ` Player${online !== 1 ? "s" : ""} online<br>X: ${cursorCoords[0] * cl.ch[0] + cursorCoords[2]} Y: ${cursorCoords[1] * cl.ch[1] + cursorCoords[3]}`;
        update = 0;
    }
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
function getProts(chunks) {
    if(!chunks) return;
    let prots = "";
    chunks.forEach(function(chunk) {
        let b = "0".repeat(31) + chunk.toString(2);
        prots += b.substring(b.length - 32);
    });
    return prots;
}
function moveCursor(dir) {
    renderCursorTile();
    if(dir === 0) {
        cursorCoords[2]--;
        if(cursorCoords[2] < 0) {
            cursorCoords[2] = cl.ch[0] - 1;
            cursorCoords[0]--;
        }
    }
    if(dir === 1) {
        cursorCoords[3]--;
        if(cursorCoords[3] < 0) {
            cursorCoords[3] = cl.ch[1] - 1;
            cursorCoords[1]--;
        }
    }
    if(dir === 2) {
        cursorCoords[2]++;
        if(cursorCoords[2] >= cl.ch[0]) {
            cursorCoords[2] = 0;
            cursorCoords[0]++;
        }
    }
    if(dir === 3) {
        cursorCoords[3]++;
        if(cursorCoords[3] >= cl.ch[1]) {
            cursorCoords[3] = 0;
            cursorCoords[1]++;
        }
    }
    renderCursorTile();
    update = 1;
}
function writeChar(char, doNotMoveCursor, erasePlaceholder) {
    char = char[0]
    if(char == "\n") {
        renderCursorTile();
        cursorCoords[0] = lineX[0];
        cursorCoords[2] = lineX[1];
        moveCursor(3);
        return;
    }
    const str = cursorCoords[0] + "," + cursorCoords[1];
    const i = cursorCoords[2] + cursorCoords[3] * cl.ch[0]
    if(!tiles[str]) return;//tiles[str] = {content: "", properties: {}};
    if(!client.isAdmin && getProts(tiles[str].properties.prot || [])[i] - 0) return;
    const char2 = getChar(...cursorCoords, true, doing == "placeholder");
    if ((char2 == char && !erasePlaceholder) || (!char2 && char == " " && erasePlaceholder)) {
        if(!doNotMoveCursor) moveCursor(2);
        update = 1;
        return;
    }
    /*const array = tiles[str].content.split("");
    array[i] = char;
    for (let t = 0; t < array.length; t++) {
        if(!array[t]) array[t] = " ";
    }
    tiles[str].content = array.join("").trimRight();*/
    queuedWrites[charCount] = [...cursorCoords];
    queuedWritesChars[charCount] = char;
    charCount++;
    renderCursorTile();
    if(!doNotMoveCursor) moveCursor(2);
    update = 1;
    return charCount - 1;
}
function setLineX() {
    lineX[0] = cursorCoords[0];
    lineX[1] = cursorCoords[2];
}
function getCoords(cx, cy) {
    const center = [c.width >> 1, c.height >> 1];
    const [x, y] = [
        Math.floor((cx - center[0] / zoom) / cl.cr[0]),
        Math.floor((cy - center[1] / zoom) / cl.cr[1])
    ];
    let tileX = Math.floor(x / cl.ch[0]);
    let tileY = Math.floor(y / cl.ch[1]);
    let pixelX = x - tileX * cl.ch[0];
    let pixelY = y - tileY * cl.ch[1];
    const str = tileX + "," + tileY;
    const i = pixelX + pixelY * cl.ch[0];
    return {str, i, chunk: [tileX, tileY]};
}
function getVisibleChunks() {
    const chunkStart = getCoords(pan[0] / zoom, pan[1] / zoom).chunk;
    const chunkEnd = getCoords(c.width / zoom - 1 + pan[0] / zoom, c.height / zoom - 1 + pan[1] / zoom).chunk;
    const array = [];
    for (let y = chunkStart[1]; y <= chunkEnd[1]; y++) {
        for (let x = chunkStart[0]; x <= chunkEnd[0]; x++) {
            array.push(x + "," + y);
        }
    }
    return array;
}
function getPos(x, y) {
    const center = [c.width >> 1, c.height >> 1];
    const pos = [
        0, 0,
        Math.floor((x - center[0] + pan[0]) / zoom / cl.cr[0]),
        Math.floor((y - center[1] + pan[1]) / zoom / cl.cr[1])
    ];
    pos[0] = Math.floor(pos[2] / cl.ch[0]);
    pos[1] = Math.floor(pos[3] / cl.ch[1]);
    pos[2] = pos[2] - pos[0] * cl.ch[0];
    pos[3] = pos[3] - pos[1] * cl.ch[1];
    return pos;
}
function drawTile(pos) {
    if(!tiles[pos]) return;
    const tile = tiles[pos];
    const drawPlaceholders = [];

    const placeholder = tile.properties.placeholder;

    tile.redraw = false;
    let [tx, ty] = pos.split(",");
    tx = parseInt(tx);
    ty = parseInt(ty);
    const prots = getProts(tile.properties.prot || []);
    q2.clearRect(0, 0, c2.width, c2.height);
    q2.font = zoom * client.fontSize + "px Fixedsys";
    q2.textAlign = "center";
    q2.fillStyle = styles.bg;
    q2.fillRect(0, 0, cl.ch[0] * cl.cr[0] * zoom, cl.ch[1] * cl.cr[1] * zoom);
    for (let t = 0; t < cl.ch[0] * cl.ch[1]; t++) {
        const w = cl.ch[0];
        const offset = [t % w, Math.floor(t / w)];
        const [x2, y2] = [
            offset[0] * cl.cr[0] * zoom,
            offset[1] * cl.cr[1] * zoom,
        ];
        let doDraw;
        q2.fillStyle = styles.text;
        if(prots[t] - 0) {
            q2.fillStyle = styles.prot_bg;
            doDraw = true;
        }
        Object.keys(queuedWrites).forEach(function(id) {
            if(queuedWrites[id].join(",") == [tx, ty, ...offset].join(",")) {
                q2.fillStyle = styles.queue;
                doDraw = true;
            }
        });
        toProt.forEach(function(prot) {
            if([prot[0], prot[1], prot[2], prot[3]].join(",") == [tx, ty, ...offset].join(",")) {
                q2.fillStyle = styles[prot[4] ? "prot" : "unprot"];
                doDraw = true;
            }
        });
        if(cursorCoords && cursorCoords[0] === tx && cursorCoords[1] === ty && cursorCoords[2] === offset[0] && cursorCoords[3] === offset[1]) {
            q2.fillStyle = styles.cursor;
            doDraw = true;
        }
        if(doDraw) q2.fillRect(x2, y2, cl.cr[0] * zoom, cl.cr[1] * zoom);
    }
    for (let t = 0; t < cl.ch[0] * cl.ch[1]; t++) {
        const w = cl.ch[0];
        const offset = [t % w, Math.floor(t / w)];
        const [x2, y2] = [
            offset[0] * cl.cr[0] * zoom,
            offset[1] * cl.cr[1] * zoom,
        ];
        let char = tile.content[t];
        Object.keys(queuedWrites).forEach(function(queuedWrite) {
            const queuedChar = queuedWritesChars[queuedWrite];
            queuedWrite = queuedWrites[queuedWrite];
            if(
                queuedWrite && queuedChar && tx === queuedWrite[0] &&
                ty === queuedWrite[1] &&
                offset[0] === queuedWrite[2] &&
                offset[1] === queuedWrite[3]
            ) char = queuedChar;
        });
        q2.fillStyle = styles[prots[t] - 0 ? "prot_text" : "text"];
        drawPlaceholders.push(function(transparent, showSpace) {
            if(!placeholder) return;
            const phChar = placeholder[offset[0] + offset[1] * cl.ch[0]];
            if(phChar) {
                if(transparent) q2.globalAlpha = .3;
                q2.fillStyle = styles[prots[t] - 0 ? "prot_text" : "text"];
                q2.fillText(showSpace && phChar[0] == " " ? "␣" : phChar[0], x2 + cl.cr[0] * zoom / 2, y2 + cl.cr[1] * zoom - 5 * zoom);
                q2.globalAlpha = 1;
            }
        });
        if(char && char != " ") q2.fillText(char, x2 + cl.cr[0] * zoom / 2, y2 + cl.cr[1] * zoom - 5 * zoom);
        else if(placeholder && !textOn(tx, ty, ...offset)) {
            drawPlaceholders[drawPlaceholders.length - 1](true);
        }
    }
    if(grid.checked) {
        q2.fillStyle = "black";
        q2.fillRect(0, 0, c2.width, 1);
        q2.fillRect(0, 0, 1, c2.height);
    }
    if(doing == "placeholder") {
        q2.globalAlpha = .8;
        q2.fillStyle = styles.bg;
        q2.fillRect(0, 0, c2.width, c2.height);
        q2.globalAlpha = 1;
        drawPlaceholders.forEach(e => {e(false, true);});
    }
    tileRenders[pos] = q2.getImageData(0, 0, c2.width, c2.height);
}
function renderCursorTile() {
    if(cursorCoords) {
        const str = cursorCoords[0] + "," + cursorCoords[1];
        if(tiles[str]) tiles[str].redraw = true;
    }
}
function getChar(tx, ty, x, y, includeQueued, placeholderMode) {
    const str = tx + "," + ty;
    if(!tiles[str]) return " ";
    if(placeholderMode) {
        const ph = tiles[str].properties.placeholder;
        if(!ph) return "";
        return (ph[x + y * cl.ch[0]] || [])[0];
    }
    if(includeQueued) {
        const ids = Object.keys(queuedWrites);
        for (let t = 0; t < ids.length; t++) {
            let queuedWrite = ids[t];
            const queuedChar = queuedWritesChars[queuedWrite];
            queuedWrite = queuedWrites[queuedWrite];
            if(
                queuedWrite && queuedChar && tx === queuedWrite[0] &&
                ty === queuedWrite[1] &&
                x === queuedWrite[2] &&
                y === queuedWrite[3]
            ) return queuedChar || " ";
        }
    }
    return tiles[str].content[x + y * cl.ch[0]] || " ";
}
function refresh() {
    Object.keys(tiles).forEach(function(pos) {
        tiles[pos].redraw = true;
    });
    update = 1;
}
function clearUnseenTiles() {
    const visibleChunks = getVisibleChunks();
    Object.keys(tiles).forEach(function(tile) {
        if(!visibleChunks.includes(tile)) delete tiles[tile];
    });
}
function textOn(tx, ty, x, y, linkId) {
    const str = tx + "," + ty;
    const i = x + y * cl.ch[0];
    if(!tiles[str]) return;
    const placeholder = tiles[str].properties.placeholder;
    if(typeof linkId == "undefined" && placeholder && placeholder[i]) linkId = placeholder[i][1];
    const tileKeys = Object.keys(tiles);
    for (let t = 0; t < tileKeys.length; t++) {
        const tile = tileKeys[t];
        let [tx2, ty2] = tile.split(",");
        tx2 = parseInt(tx2);
        ty2 = parseInt(ty2);
        if(tiles[tile].properties.placeholder) for (let t = 0; t < cl.ch[0] * cl.ch[1]; t++) {
            const char = tiles[tile].properties.placeholder[t];
            if(
                char && linkId === char[1] &&
                getChar(tx2, ty2, t % cl.ch[0], Math.floor(t / cl.ch[0])) != " "
            ) return true;
        }
    }
}
function placeholderNames(pos) {
    if(!tiles[pos]) return [];
    if(!tiles[pos].properties.placeholder) return [];
    const placeholder = tiles[pos].properties.placeholder;
    const array = [];
    Object.keys(placeholder).forEach(function(i) {
        if(!array.includes(placeholder[i][1])) array.push(placeholder[i][1]);
    });
    return array;
}
c.addEventListener("mousedown", function(e) {
    e.preventDefault();
    panning = true;
});
c.addEventListener("click", function(e) {
    ta.focus();
    renderCursorTile();
    cursorCoords = getPos(e.clientX, e.clientY);
    renderCursorTile();
    setLineX();
    update = 1;
    if(doing == "placeholder") {
        const str = cursorCoords[0] + "," + cursorCoords[1]
        const i = cursorCoords[2] + cursorCoords[3] * cl.ch[0];
        if(
            tiles[str] && tiles[str].properties.placeholder &&
            tiles[str].properties.placeholder[i]
        ) link.value = tiles[str].properties.placeholder[i][1];
    }
});
addEventListener("mouseup", function(e) {
    panning = false;
});
addEventListener("mousemove", function(e) {
    if (panning && !(doing == "prot" && (e.ctrlKey || e.shiftKey))) {
        pan[0] += prevMousePos[0] - e.clientX;
        pan[1] += prevMousePos[1] - e.clientY;
        update = 1;
    }
    prevMousePos[0] = e.clientX;
    prevMousePos[1] = e.clientY;
    if(doing == "prot" && (e.ctrlKey || e.shiftKey) && [1, 2].includes(e.buttons)) {
        const data = [...getPos(e.clientX, e.clientY), e.buttons === 2 ? 0 : 1];
        let overlaps;
        toProt.forEach(function(prot, index) {
            if(prot.slice(0, 4).join(",") == data.slice(0, 4).join(",")) {
                if(e.shiftKey) delete toProt[index]; else overlaps = index;
            }
        });
        if (!e.shiftKey) if(typeof overlaps == "number") toProt[overlaps] = data; else toProt.push(data);
        tiles[data[0] + "," + data[1]].redraw = true;
        update = 1;
    }
});
addEventListener("touchstart", function(e) {
    prevMousePos[0] = e.changedTouches[0].clientX;
    prevMousePos[1] = e.changedTouches[0].clientY;
})
addEventListener("touchmove", function(e) {
    e.clientX = e.changedTouches[0].clientX;
    e.clientY = e.changedTouches[0].clientY;
    if (!(doing == "prot" && (e.ctrlKey || e.shiftKey))) {
        pan[0] += prevMousePos[0] - e.clientX;
        pan[1] += prevMousePos[1] - e.clientY;
        update = 1;
    }
    prevMousePos[0] = e.clientX;
    prevMousePos[1] = e.clientY;
    if(doing == "prot" && (e.ctrlKey || e.shiftKey) && [1, 2].includes(e.buttons)) {
        const data = [...getPos(e.clientX, e.clientY), e.buttons === 2 ? 0 : 1];
        let overlaps;
        toProt.forEach(function(prot, index) {
            if(prot.slice(0, 4).join(",") == data.slice(0, 4).join(",")) {
                if(e.shiftKey) delete toProt[index]; else overlaps = index;
            }
        });
        if (!e.shiftKey) if(typeof overlaps == "number") toProt[overlaps] = data; else toProt.push(data);
        tiles[data[0] + "," + data[1]].redraw = true;
        update = 1;
    }
});
addEventListener("load", function() {
    update = 1;
});
c.addEventListener("wheel", function(e) {
    if(e.ctrlKey) {
        e.preventDefault();
        zoomAt += e.deltaY > 0 ? -1 : 1;
        if(zoomAt < 0) zoomAt = 0;
        if(zoomAt >= zooms.length) zoomAt = zooms.length - 1;
        pan[0] /= zoom / zooms[zoomAt];
        pan[1] /= zoom / zooms[zoomAt];
        zoom = zooms[zoomAt];
        onClientChange();
        refresh();
        zoomElm.value = zoomAt;
    } else {
        pan[e.shiftKey ? 0 : 1] += e.deltaY;
        update = 1;
    }
});
ta.addEventListener("keydown", function(e) {
    if(e.keyCode >= 37 && e.keyCode < 41) {
        moveCursor(e.keyCode - 37);
        setLineX();
    }
    if(e.code == "Backspace") {
        moveCursor(0);
        const id = writeChar(" ", true, doing == "placeholder");
        if(id) send({kind: "write", edits: [[...queuedWrites[id], doing == "placeholder" ? false : " ", id, doing == "placeholder"]]}, socket);
    } 
});
ta.addEventListener("input", function(e) {
    const isPaste = ta.value.length > 1;
    if (!isPaste || lastPaste + 250 < Date.now()) {
        const edits = [];
        for (let t = 0; t < ta.value.length && t < client.pasteLimit && t < maxPasteLimit; t++) {
            const id = writeChar(ta.value[t]);
            if(id) edits.push([...queuedWrites[id], ta.value[t], id, doing == "placeholder", link.value]);
        }
        if(edits.length) send({kind: "write", edits}, socket);
        if(isPaste) lastPaste = Date.now();
    }
    ta.value = "";
});
document.getElementById("protect").addEventListener("click", function() {
    if(doing) return;
    document.getElementById("done").style.display = null;
    doing = "prot";
});
document.getElementById("done").addEventListener("click", function(e) {
    if(doing == "prot") {
        if(toProt.length) send({kind: "prot", edits: toProt}, socket);
        toProt = [];
    }
    if(doing == "placeholder") {
        refresh();
        document.getElementById("placeholderopts").style.display = "none";
    }
    if(doing == "import") {
        const ii = document.getElementById("importinput");
        ii.style.display = "none";
        let data;
        try {
            data = JSON.parse(ii.value);
            send({kind: "import", tiles: data.tiles, config: data.config}, socket);
        } catch (error) {}
    }
    e.target.style.display = "none";
    doing = "";
});
c.addEventListener("contextmenu", function(e) {
    e.preventDefault();
});
document.getElementById("amount").addEventListener("change", function(e) {
    send({kind: "config", amount: e.target.value - 0}, socket);
});
document.getElementById("per").addEventListener("change", function(e) {
    send({kind: "config", per: e.target.value - 0}, socket);
});
document.getElementById("cep").addEventListener("change", function(e) {
    send({kind: "config", canEditPlaceholders: e.target.checked}, socket);
});
document.getElementById("placeholder").addEventListener("click", function() {
    if(doing) return;
    document.getElementById("done").style.display = null;
    doing = "placeholder";
    refresh();
    document.getElementById("placeholderopts").style.display = null;
    link.value = Math.floor(Math.random() * 0x100000000).toString(16);
});
grid.addEventListener("change", function(e) {
    refresh();
});
document.getElementById("download").addEventListener("click", function() {
    send({kind: "download"}, socket);
});
document.getElementById("import").addEventListener("click", function() {
    if(doing) return;
    document.getElementById("done").style.display = null;
    doing = "import";
    document.getElementById("importinput").style.display = "block";
});
zoomElm.addEventListener("input", function() {
    zoomAt = zoomElm.value - 0;
    pan[0] /= zoom / zooms[zoomAt];
    pan[1] /= zoom / zooms[zoomAt];
    zoom = zooms[zoomAt];
    onClientChange();
    refresh();
});
document.getElementById("togglestyles").addEventListener("click", function() {
    const elm = document.getElementById("styles");
    elm.style.display = elm.style.display ? null : "none";
});
function connect() {
    tiles = {};
    queuedWrites = {};
    queuedWritesChars = {};
    let message;
    m.showModal();
    if(navigator.userAgentData && navigator.userAgentData.mobile && !confirm("I do not recommend using this site on your mobile at all, press OK to play anyway")) {
        m.innerHTML = "Cancelled";
        return;
    }
    socket = new WebSocket((location.protocol == "https:" ? "wss://" : "ws://") + location.host + "/ws" + location.search);
    socket.onopen = function() {
        m.close();
        ta.blur();
        ta.focus();
        update = 1;
    };
    socket.onmessage = function(e) {
        const data = JSON.parse(e.data);
        const kind = data.kind;
        if(kind == "load") {
            client.charSize[0] = data.charSize[0];
            client.charSize[1] = data.charSize[1];
            client.chunkSize[0] = data.chunkSize[0];
            client.chunkSize[1] = data.chunkSize[1];
            client.pasteLimit = data.pasteLimit;
            if(typeof data.isAdmin != "undefined") client.isAdmin = data.isAdmin;
            client.fontSize = data.fontSize;
            document.getElementById("amount").value = data.rateLimit[0];
            document.getElementById("per").value = data.rateLimit[1];
            document.getElementById("cep").checked = data.canEditPlaceholders;
            const placeholderOption = data.canEditPlaceholders || client.isAdmin;
            document.getElementById("placeholder").style.display = placeholderOption ? null : "none";
            if(doing == "placeholder" && !placeholderOption) document.getElementById("done").click();
            onClientChange();
            if(data.isAdmin) document.getElementById("admin_panel").style.display = null;
        }
        if(kind == "tiles") {
            Object.keys(data.tiles).forEach(function(pos) {
                tiles[pos] = data.tiles[pos];
                tiles[pos].redraw = true;
                const indexOf = loading.indexOf(pos);
                if(~indexOf) delete loading[indexOf];
                if(tiles[pos].properties.placeholder) {
                    const placeholder = tiles[pos].properties.placeholder;
                    Object.keys(placeholder).forEach(function(phChar) {
                        const name = placeholder[phChar][1];
                        const isOn = textOn(0, 0, 0, 0, name);
                        if(Boolean(placeholderStates[name]) != Boolean(isOn)) placeholderChange[name] = true;
                    });
                }
            });
            Object.keys(placeholderChange).forEach(function(name) {
                placeholderStates[name] = placeholderStates[name] ^ placeholderChange[name];
                delete placeholderChange[name];
                Object.keys(tiles).forEach(function(tile) {
                    if(placeholderNames(tile).includes(name)) tiles[tile].redraw = true;
                });
            });
            if(!loading.join("")) loading = [];
        }
        if(kind == "wrote") {
            data.ids.forEach(function(id) {
                const w = queuedWrites[id];
                if (w) {
                    const str = w[0] + "," + w[1]
                    delete queuedWrites[id];
                    delete queuedWritesChars[id];
                    if(tiles[str]) tiles[str].redraw = true;
                }
            });
        }
        if(kind == "clear") {
            tiles = {};
        }
        if(kind == "download") {
            navigator.clipboard.writeText(JSON.stringify(data.data));
            alert("Copied text to clipboard");
        }
        if(kind == "closed") message = data.msg;
        if(kind == "online") online = data.online;
        update = 1;
    };
    socket.onclose = function() {
        m.showModal();
        m.innerHTML = message || "Lost connection";
        const reconnect = document.createElement("button");
        reconnect.innerHTML = "Reconnect";
        reconnect.addEventListener("click", function() {
            connect();
        });
        m.appendChild(reconnect);
    }
    m.innerHTML = "Connecting";
}
function send(data, s) {
    if(s && s.readyState === s.OPEN) s.send(JSON.stringify(data));
}
document.getElementById("styles").childNodes.forEach(function(style) {
    if(!style.id) return;
    styles[style.id.replace("style_", "")] = style.value;
    style.addEventListener("input", function() {
        styles[style.id.replace("style_", "")] = style.value;
        refresh();
        update = 1;
    });
});
connect();