'use strict';
const ws = require('ws');
const express = require("express");
const path = require('path');
const JsonDB = require("node-json-db").JsonDB;
const Config = require("node-json-db").Config;
const app = express();
const port = process.env.PORT || 10000;
const adminKey = process.env.ADMIN_TOKEN;
//app.use(express.json());

const opts = { root: path.join(__dirname, "public"), extensions: ["html", "htm"] };

app.get("/{*path}", (req, res) => {
    res.sendFile(req.path, opts, function(err) {
        if(err) res.status(404).json({message: "not found"});
    });
});

const server = app.listen(port, () => {
    console.log('Server is running on http://localhost:' + port);
});

const ips = {};
const max_sockets = 5;
var db = new JsonDB(new Config("tiles", true, false, '/'));
var tiles = {};
var config = {
    chunkSize: [16, 8],
    charSize: [10, 20],
    fontSize: 20,
    pasteLimit: 200,
    rateLimit: [4, 250],
    canEditPlaceholders: true
};
var unsaved = [0, 0];
(async function() {
    var data = await db.getData("/");
    if(!data.tiles) db.push("/tiles", tiles);
    if(!data.config) db.push("/config", config);
    tiles = await db.getData("/tiles");
    config = await db.getData("/config");
})();
const wsServer = new ws.Server({server, path: "/ws"});
wsServer.on("connection", function(e, req) {
    var ip = (req.headers["x-forwarded-for"] || "127.0.0.1").split(",")[0];
    if(!ips[ip]) ips[ip] = {sockets: 0};
    if(ips[ip].sockets >= max_sockets) {
        send({kind: "closed", msg: `Too many tabs open (max is ${max_sockets})`}, e);
        e.close();
        return;
    }
    ips[ip].sockets++;
    e.isAdmin = req.url.includes(adminKey); // very stupid way
    e.edits = [];
    e.cps = e.isAdmin ? Infinity : config.rateLimit[0];
    send({kind: "load", ...config ,isAdmin: e.isAdmin}, e);
    e.on("message", async function(a) {
        var data = {};
        try {
            data = JSON.parse(a.toString());
        } catch (err) {
            e.close();
            return;
        }
        const kind = data.kind;
        if(kind == "write") {
            const edits = (data.edits || []);
            if(edits.constructor != Array || !edits.length) return;
            e.edits.push(...edits.slice(0, 500));
            function applyEdits() {
                const ids = [];
                const obj = {};
                while (e.cps > 0 && e.edits.length) {
                    const edit = e.edits.shift();
                    if(!edit) continue;
                    ids.push(edit[5]);
                    let tileX = edit[0];
                    let tileY = edit[1];
                    let charX = edit[2];
                    let charY = edit[3];
                    let char = edit[4];
                    if(typeof tileX != "number" || isNaN(tileX)) return;
                    if(typeof tileY != "number" || isNaN(tileY)) return;
                    if(typeof charX != "number" || isNaN(charX)) return;
                    if(typeof charY != "number" || isNaN(charY)) return;
                    if(charX < 0 || charX >= config.chunkSize[0]) return;
                    if(charY < 0 || charY >= config.chunkSize[1]) return;
                    const str = tileX + "," + tileY;
                    const i = charX + charY * config.chunkSize[0];
                    if(!tiles[str]) tiles[str] = newTile();
                    if(!e.isAdmin && getProts(tiles[str].properties.prot || [])[i] - 0) continue;
                    if (edit[6]) {
                        if (config.canEditPlaceholders || e.isAdmin) {
                            if(!tiles[str].properties.placeholder) tiles[str].properties.placeholder = {};
                            if(char) tiles[str].properties.placeholder[i] = [char[0], edit[7] || "none"];
                            else delete tiles[str].properties.placeholder[i];
                            if(!Object.keys(tiles[str].properties.placeholder).length) delete tiles[str].properties.placeholder;
                        }
                    } else {
                        const array = tiles[str].content.split("");
                        array[i] = char[0] || " ";
                        for (let t = 0; t < array.length; t++) {
                            if(!array[t]) array[t] = " ";
                        }
                        tiles[str].content = array.join("").trimRight();
                    }
                    obj[str] = tiles[str];
                    if(isEmpty(tiles[str])) delete tiles[str];
                    e.cps--;
                    unsaved[0] = 1;
                }
                if(ids.length) send({kind: "wrote", ids}, e);
                if(Object.keys(obj).length) broadcast({kind: "tiles", tiles: obj});
            }
            if(!e.iId) applyEdits();
            if(!e.iId && e.edits.length) e.iId = setTimeout(function doApply() {
                if(e.readyState !== e.OPEN) return clearInterval(e.iId);
                e.cps = config.rateLimit[0];
                applyEdits();
                if(!e.edits.length) {
                    delete e.iId;
                    return;
                }
                e.iId = setTimeout(doApply, config.rateLimit[1]);
            }, config.rateLimit[1]);

        }
        if(kind == "tiles") {
            const obj = {};
            const tilesToSend = (data.tiles || []);
            if(tilesToSend.constructor != Array) return;
            tilesToSend.forEach(function(tile) {
                obj[tile] = tiles[tile] || newTile();
            });
            send({kind: "tiles", tiles: obj}, e);
        }
        if(e.isAdmin) {
            if(kind == "prot") {
                const obj = {};
                const edits = (data.edits || []);
                if(edits.constructor != Array || !edits.length) return;
                edits.forEach(function(edit) {
                    if(!edit) return;
                    const str = edit[0] + "," + edit[1];
                    const i = edit[2] + edit[3] * config.chunkSize[0];
                    if(!tiles[str]) tiles[str] = newTile();
                    if(!tiles[str].properties.prot) tiles[str].properties.prot = new Array(Math.ceil(config.chunkSize[0] * config.chunkSize[1] / 32)).fill(0);
                    const str2 = ("0".repeat(31) + (tiles[str].properties.prot[Math.floor(i / 32)] || 0).toString(2));
                    const array = str2.substring(str2.length - 32).split("");
                    array[i % 32] = edit[4] ? "1" : "0";
                    tiles[str].properties.prot[Math.floor(i / 32)] = parseInt(array.join(""), 2);
                    if(isAllZero(tiles[str].properties.prot)) delete tiles[str].properties.prot;
                    obj[str] = tiles[str];
                    if(isEmpty(tiles[str])) delete tiles[str];
                })
                broadcast({kind: "tiles", tiles: obj});
                unsaved[0] = 1;
            }
            if(kind == "config") {
                if(typeof data.amount == "number") config.rateLimit[0] = data.amount;
                if(typeof data.per == "number") config.rateLimit[1] = data.per;
                if(typeof data.canEditPlaceholders == "boolean") config.canEditPlaceholders = data.canEditPlaceholders;
                broadcast({kind: "load", ...config});
                unsaved[1] = 1;
            }
            if(kind == "download") send({kind: "download", data: {tiles, config}}, e);
            if(kind == "import") {
                tiles = data.tiles || {};
                config = data.config || {};
                if(!config.chunkSize) config.chunkSize = [16, 8];
                if(!config.charSize) config.charSize = [10, 20];
                if(typeof config.fontSize == "undefined") config.fontSize = 20;
                if(typeof config.pasteLimit == "undefined") config.pasteLimit = 200;
                if(!config.rateLimit) config.rateLimit = [4, 250];
                if(typeof config.canEditPlaceholders == "undefined") config.canEditPlaceholders = true;
                db.push("/", {tiles, config});
                broadcast({kind: "load", ...config});
                broadcast({kind: "clear"});
            }
        }
    });
    e.on("close", function() {
        ips[ip].sockets--;
    });
});
function broadcast(b, exclude) {
    wsServer.clients.forEach(function(client) {
        if(client != exclude) client.send(JSON.stringify(b));
    });
}
function send(m, s) {
    if(s) s.send(JSON.stringify(m));
}
function newTile() {
    return {content: "", properties: {}};
}
function getProts(chunks) {
    if(!chunks) return;
    let prots = "";
    chunks.forEach(function(chunk) {
        let b = "0".repeat(31) + chunk.toString(2);
        prots += b.substring(b.length - 32);
    });
    return prots;
}
function isAllZero(array) {
    let isZero = true;
    for (let t = 0; t < array.length; t++) if(array[t] !== 0) isZero = false;
    return isZero;
}
function isEmpty(tile) {
    return !tile.content && !Object.keys(tile.properties).length;
}
setInterval(() => {
    if(unsaved[0]) {db.push("/tiles", tiles); unsaved[0] = 0;}
    if(unsaved[1]) {db.push("/config", config); unsaved[1] = 0;}
}, 1000 * 60);