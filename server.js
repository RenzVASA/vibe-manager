const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const DJ_PASSWORD = process.env.DJ_PASSWORD || '123';
let db;

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (let devName in interfaces) {
        let iface = interfaces[devName];
        for (let i = 0; i < iface.length; i++) {
            let alias = iface[i];
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                return alias.address;
            }
        }
    }
    return '0.0.0.0';
}

const localIP = getLocalIP();

let settings = {
    cooldownPropose: 10 * 60 * 1000,
    cooldownVote: 2 * 60 * 1000,
    autoNext: false
};

(async () => {
    db = await open({ filename: './database.sqlite', driver: sqlite3.Database });
    await db.exec(`
        CREATE TABLE IF NOT EXISTS tracks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            artist TEXT NOT NULL DEFAULT 'Inconnu',
            votes INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'pending',
            pass INTEGER NOT NULL DEFAULT 1,
            proposed_by TEXT,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );
        CREATE TABLE IF NOT EXISTS actions (
            device_id TEXT PRIMARY KEY,
            last_propose INTEGER DEFAULT 0,
            last_vote INTEGER DEFAULT 0,
            voted_tracks TEXT DEFAULT '[]'
        );
    `);
})();

app.use(express.json());
app.use(express.static('public'));

// ── API Export ────────────────────────────────────────────────────────────────
app.get('/api/export', async (req, res) => {
    if (req.query.password !== DJ_PASSWORD) return res.status(401).json({ error: 'Non autorisé' });
    const tracks = await db.all("SELECT * FROM tracks ORDER BY status DESC, votes DESC, created_at ASC");
    res.json(tracks);
});

// ── API Import ────────────────────────────────────────────────────────────────
app.post('/api/import', async (req, res) => {
    const { password, tracks } = req.body;
    if (password !== DJ_PASSWORD) return res.status(401).json({ error: 'Non autorisé' });
    if (!Array.isArray(tracks) || !tracks.length) return res.status(400).json({ error: 'Liste invalide' });
    let added = 0;
    for (const t of tracks) {
        const title  = (t.title  || '').trim();
        const artist = (t.artist || 'Inconnu').trim();
        if (!title) continue;
        const exists = await db.get("SELECT id FROM tracks WHERE LOWER(title)=LOWER(?)", [title]);
        if (!exists) {
            await db.run("INSERT INTO tracks (title, artist, votes) VALUES (?,?,0)", [title, artist]);
            added++;
        }
    }
    await broadcastUpdate();
    res.json({ added });
});

// ── Broadcast ─────────────────────────────────────────────────────────────────
async function broadcastUpdate() {
    const tracks = await db.all(`
        SELECT * FROM tracks
        WHERE status IN ('pending','next')
        ORDER BY
            CASE WHEN status='next' THEN 0 ELSE 1 END ASC,
            votes DESC,
            created_at ASC
    `);
    const played = await db.all("SELECT * FROM tracks WHERE status='played' ORDER BY created_at DESC LIMIT 15");
    const nextTrack = tracks.find(t => t.status === 'next') || null;

    io.emit('updateList', tracks);
    io.emit('playedList', played);
    io.emit('nextUpdate', nextTrack);
}

// ── Socket ────────────────────────────────────────────────────────────────────
io.on('connection', async (socket) => {
    console.log(`[CONNEXION] Nouvel invité connecté (ID: ${socket.id.substring(0,4)})`);

    const tracks = await db.all(`
        SELECT * FROM tracks WHERE status IN ('pending','next')
        ORDER BY CASE WHEN status='next' THEN 0 ELSE 1 END ASC, votes DESC, created_at ASC
    `);
    const played = await db.all("SELECT * FROM tracks WHERE status='played' ORDER BY created_at DESC LIMIT 15");
    const nextTrack = await db.get("SELECT * FROM tracks WHERE status='next' LIMIT 1");

    socket.emit('init', { pending: tracks, played, nextTrack });
    socket.emit('settings', settings);

    // ── Auth ──
    socket.on('djAuth', ({ password }, cb) => {
        if (password === DJ_PASSWORD) {
            socket.djAuthenticated = true;
            console.log(`[ADMIN] Le DJ s'est connecté avec succès.`);
            cb({ ok: true });
        } else {
            console.log(`[ALERTE] Tentative de connexion Admin échouée !`);
            cb({ ok: false });
        }
    });

    // ── Propose ──
    socket.on('propose', async ({ deviceId, title, artist }) => {
        const t = title.trim();
        const a = artist.trim() || 'Inconnu';
        if (!t) return;

        const user = await db.get("SELECT * FROM actions WHERE device_id=?", [deviceId]) || { last_propose: 0, voted_tracks: '[]' };

        const isPlayed = await db.get("SELECT id FROM tracks WHERE LOWER(title)=LOWER(?) AND status='played'", [t]);
        if (isPlayed) return socket.emit('error_msg', { message: "Déjà joué ce soir !" });

        const existing = await db.get("SELECT * FROM tracks WHERE LOWER(title)=LOWER(?) AND status IN ('pending','next')", [t]);

        if (existing) {
            const voted = JSON.parse(user.voted_tracks || '[]');
            if (voted.includes(existing.id)) return socket.emit('error_msg', { message: "Déjà voté pour ce titre !" });
            await db.run("UPDATE tracks SET votes=votes+1 WHERE id=?", [existing.id]);
            voted.push(existing.id);
            await db.run("INSERT OR REPLACE INTO actions (device_id, voted_tracks) VALUES (?,?)", [deviceId, JSON.stringify(voted)]);
            console.log(`[VOTE+] Titre existant : "${existing.title}" (+1 vote)`);
        } else {
            if (Date.now() - user.last_propose < settings.cooldownPropose) {
                const rem = Math.ceil((settings.cooldownPropose - (Date.now() - user.last_propose)) / 1000);
                const m = Math.floor(rem / 60), s = rem % 60;
                return socket.emit('error_msg', { message: `Attends encore ${m > 0 ? m + 'min ' : ''}${s}s avant de proposer.` });
            }
            const res = await db.run("INSERT INTO tracks (title, artist, proposed_by) VALUES (?,?,?)", [t, a, deviceId]);
            const voted = JSON.parse(user.voted_tracks || '[]');
            voted.push(res.lastID);
            await db.run("INSERT OR REPLACE INTO actions (device_id, last_propose, voted_tracks) VALUES (?,?,?)", [deviceId, Date.now(), JSON.stringify(voted)]);
            console.log(`[PROPOSITION] Nouveau titre : "${t}" par ${a}`);
            socket.emit('propose_ok');
        }
        broadcastUpdate();
    });

    // ── Vote ──
    socket.on('vote', async ({ deviceId, trackId }) => {
        const user = await db.get("SELECT * FROM actions WHERE device_id=?", [deviceId]) || { last_vote: 0, voted_tracks: '[]' };
        const voted = JSON.parse(user.voted_tracks || '[]');
        if (voted.includes(trackId)) return socket.emit('error_msg', { message: "Déjà voté !" });
        if (Date.now() - user.last_vote < settings.cooldownVote) {
            const rem = Math.ceil((settings.cooldownVote - (Date.now() - user.last_vote)) / 1000);
            const m = Math.floor(rem / 60), s = rem % 60;
            return socket.emit('error_msg', { message: `Attends encore ${m > 0 ? m + 'min ' : ''}${s}s avant de voter.` });
        }
        const track = await db.get("SELECT title FROM tracks WHERE id=?", [trackId]);
        await db.run("UPDATE tracks SET votes=votes+1 WHERE id=?", [trackId]);
        voted.push(trackId);
        await db.run("INSERT OR REPLACE INTO actions (device_id, last_vote, voted_tracks) VALUES (?,?,?)", [deviceId, Date.now(), JSON.stringify(voted)]);
        console.log(`[VOTE] Vote reçu pour : "${track ? track.title : 'ID ' + trackId}"`);
        socket.emit('voted', trackId);
        broadcastUpdate();
    });

    // ── Unvote ──
    socket.on('unvote', async ({ deviceId, trackId }) => {
        const user = await db.get("SELECT * FROM actions WHERE device_id=?", [deviceId]);
        if (!user) return;
        const voted = JSON.parse(user.voted_tracks || '[]');
        if (!voted.includes(trackId)) return;
        await db.run("UPDATE tracks SET votes=MAX(0, votes-1) WHERE id=?", [trackId]);
        const newVoted = voted.filter(id => id !== trackId);
        await db.run("UPDATE actions SET voted_tracks=? WHERE device_id=?", [JSON.stringify(newVoted), deviceId]);
        socket.emit('unvoted', trackId);
        broadcastUpdate();
    });

    // ── DJ : Auto-Next toggle ──
    socket.on('toggleAuto', (val) => {
        if (!socket.djAuthenticated) return;
        settings.autoNext = val;
        console.log(`[MODE] Auto-Next : ${val ? 'ACTIVÉ' : 'DÉSACTIVÉ'}`);
        io.emit('settings', settings);
    });

    // ── DJ : Mark as Next ──
    socket.on('markAsNext', async (id) => {
        if (!socket.djAuthenticated) return;
        const track = await db.get("SELECT title FROM tracks WHERE id=?", [id]);
        await db.run("UPDATE tracks SET status='pending' WHERE status='next'");
        await db.run("UPDATE tracks SET status='next' WHERE id=?", [id]);
        console.log(`[DJ] Sélection forcée : "${track ? track.title : 'ID ' + id}" est le prochain.`);
        broadcastUpdate();
    });

    // ── DJ : Mark as Played ──
    socket.on('markAsPlayed', async (id) => {
        if (!socket.djAuthenticated) return;
        const track = await db.get("SELECT title FROM tracks WHERE id=?", [id]);
        await db.run("UPDATE tracks SET status='played', created_at=strftime('%s','now') WHERE id=?", [id]);
        console.log(`[LANCEMENT] En train de jouer : "${track ? track.title : 'ID ' + id}"`);

        if (settings.autoNext) {
            const nextBest = await db.get("SELECT id, title FROM tracks WHERE status='pending' ORDER BY votes DESC, created_at ASC LIMIT 1");
            if (nextBest) {
                await db.run("UPDATE tracks SET status='next' WHERE id=?", [nextBest.id]);
                console.log(`[AUTO-NEXT] "${nextBest.title}" sélectionné automatiquement.`);
            }
        }
        broadcastUpdate();
    });

    // ── DJ : Second Pass ──
    // Les played reviennent dans la liste en orange (pass=2)
    // Les 3 derniers joués (les plus récents) reçoivent 3 votes de départ
    // Tout le reste remis à 0 — tout le monde peut revoter
    socket.on('secondPass', async () => {
        if (!socket.djAuthenticated) return;
        const played = await db.all("SELECT * FROM tracks WHERE status='played' ORDER BY created_at DESC");
        if (!played.length) return socket.emit('error_msg', { message: "Aucun morceau joué ce soir." });

        const top3ids = played.slice(0, 3).map(t => t.id);
        await db.run("UPDATE tracks SET status='pending', pass=2, votes=0 WHERE status='played'");
        for (const id of top3ids) {
            await db.run("UPDATE tracks SET votes=3 WHERE id=?", [id]);
        }
        await db.run("UPDATE actions SET voted_tracks='[]'");
        console.log(`[RESTART] Le 2ème passage a été activé !`);
        io.emit('secondPassActivated');
        broadcastUpdate();
    });

    // ── DJ : Delete ──
    socket.on('deleteTrack', async (id) => {
        if (!socket.djAuthenticated) return;
        const track = await db.get("SELECT title, status FROM tracks WHERE id=?", [id]);
        await db.run("DELETE FROM tracks WHERE id=?", [id]);
        console.log(`[SUPPRESSION] Le titre "${track ? track.title : 'ID ' + id}" a été supprimé.`);
        broadcastUpdate();
    });

    // ── DJ : Clear All ──
    socket.on('clearAll', async () => {
        if (!socket.djAuthenticated) return;
        await db.run("DELETE FROM tracks");
        await db.run("UPDATE actions SET last_propose=0, last_vote=0, voted_tracks='[]'");
        console.log(`[RESET] Toute la base de données a été effacée.`);
        io.emit('nextUpdate', null);
        io.emit('playedList', []);
        broadcastUpdate();
    });

    // ── DJ : Update Settings ──
    socket.on('updateSettings', (newS) => {
        if (!socket.djAuthenticated) return;
        settings = { ...settings, ...newS };
        console.log(`[PARAMÈTRES] Mise à jour des configurations DJ.`);
        io.emit('settings', settings);
    });

    socket.on('disconnect', () => {
        console.log(`[DÉCONNEXION] Un invité est parti.`);
    });
});

server.listen(3000, '0.0.0.0', () => {
    console.log('\x1b[36m%s\x1b[0m', '===========================================');
    console.log('\x1b[32m%s\x1b[0m', '🚀 DJ SERVER EST EN LIGNE');
    console.log(`🏠 LOCAL   : http://localhost:3000`);
    console.log(`🏠 LOCAL   : http://localhost:3000/admin.html`);
    console.log(`🏠 LOCAL   : http://localhost:3000/live.html`);
    console.log(`🏠 LOCAL   : http://localhost:3000/export.html`);
    console.log(`🌐 RÉSEAU  : http://${localIP}:3000`);
    console.log(`🌐 RÉSEAU  : http://${localIP}:3000/admin.html`);
    console.log(`🌐 RÉSEAU  : http://${localIP}:3000/live.html`);
    console.log(`🔐 PASS DJ : ${DJ_PASSWORD}`);
    console.log('\x1b[36m%s\x1b[0m', '===========================================');
    console.log('Logs activité en direct :');
});