const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const SAVED_STREAMS_FILE = path.join(__dirname, 'saved-streams.json');
const CAPTURES_DIR = path.join(__dirname, 'captures');

app.use(express.json());
app.use(express.static('public'));
app.use('/captures', express.static('captures'));

const activeStreams = new Map();
const savedStreams = loadSavedStreams();

function ensureDirectoryExists(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function loadSavedStreams() {
    if (!fs.existsSync(SAVED_STREAMS_FILE)) {
        return [];
    }

    try {
        const content = fs.readFileSync(SAVED_STREAMS_FILE, 'utf8');
        const parsed = JSON.parse(content);
        if (!Array.isArray(parsed)) {
            return [];
        }

        return parsed.map((stream) => ({
            rtspUrl: stream.rtspUrl,
            lastStreamId: stream.lastStreamId,
            lastStartedAt: stream.lastStartedAt,
            label: stream.label || '',
            notes: stream.notes || '',
            screenshots: Array.isArray(stream.screenshots) ? stream.screenshots : []
        }));
    } catch (error) {
        console.error('Failed to read saved streams file:', error.message);
        return [];
    }
}

function sanitizeText(value, maxLength) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function persistSavedStreams() {
    try {
        fs.writeFileSync(SAVED_STREAMS_FILE, JSON.stringify(savedStreams, null, 2));
    } catch (error) {
        console.error('Failed to write saved streams file:', error.message);
    }
}

function upsertSavedStream(rtspUrl, streamId, metadata = {}) {
    const now = new Date().toISOString();
    const existing = savedStreams.find((stream) => stream.rtspUrl === rtspUrl);
    const label = sanitizeText(metadata.label, 60);
    const notes = sanitizeText(metadata.notes, 280);

    if (existing) {
        existing.lastStreamId = streamId;
        existing.lastStartedAt = now;
        if (label) {
            existing.label = label;
        }
        if (notes) {
            existing.notes = notes;
        }
    } else {
        savedStreams.push({
            rtspUrl,
            lastStreamId: streamId,
            lastStartedAt: now,
            label,
            notes,
            screenshots: []
        });
    }

    persistSavedStreams();
}

function addScreenshotRecord(rtspUrl, streamId, fileName) {
    const now = new Date().toISOString();
    let existing = savedStreams.find((stream) => stream.rtspUrl === rtspUrl);

    if (!existing) {
        existing = {
            rtspUrl,
            lastStreamId: streamId,
            lastStartedAt: now,
            label: '',
            notes: '',
            screenshots: []
        };
        savedStreams.push(existing);
    }

    existing.screenshots.unshift({
        fileName,
        capturedAt: now
    });

    if (existing.screenshots.length > 20) {
        existing.screenshots.length = 20;
    }

    persistSavedStreams();
}

function cleanupStream(streamId) {
    const streamInfo = activeStreams.get(streamId);
    if (streamInfo) {
        if (streamInfo.ffmpegProcess) {
            streamInfo.ffmpegProcess.kill('SIGTERM');
        }
        
        const streamDir = path.join(__dirname, 'streams', streamId);
        if (fs.existsSync(streamDir)) {
            fs.rmSync(streamDir, { recursive: true, force: true });
        }
        
        activeStreams.delete(streamId);
        console.log(`Cleaned up stream: ${streamId}`);
    }
}

app.post('/start-stream', (req, res) => {
    const { rtspUrl, label, notes } = req.body;
    
    if (!rtspUrl) {
        return res.status(400).json({ error: 'RTSP URL is required' });
    }

    const startupTimeoutMs = parseInt(process.env.STREAM_STARTUP_TIMEOUT_MS, 10) || 15000;
    const startupPollMs = parseInt(process.env.STREAM_STARTUP_POLL_MS, 10) || 500;
    
    const streamId = uuidv4();
    const streamDir = path.join(__dirname, 'streams', streamId);
    ensureDirectoryExists(streamDir);
    
    const playlistPath = path.join(streamDir, 'playlist.m3u8');
    const hlsTimeSeconds = 2;
    const segmentPath = path.join(streamDir, 'stream_%03d.ts');

    let responded = false;
    let pollTimer = null;
    let timeoutTimer = null;

    const finalize = (status, payload) => {
        if (responded) return;
        responded = true;
        if (pollTimer) clearInterval(pollTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        res.status(status).json(payload);
    };
    
    console.log(`Starting stream ${streamId} for URL: ${rtspUrl}`);
    
    const ffmpegProcess = ffmpeg(rtspUrl)
        .inputOptions([
            '-rtsp_transport', 'tcp',
            '-analyzeduration', '30000000',
            '-probesize', '50000000',
            '-max_delay', '500000'
        ])
        .videoCodec('libx264')
        .audioCodec('aac')
        .outputOptions([
            '-preset', 'veryfast',
            '-tune', 'zerolatency',
            '-f', 'hls',
            '-hls_time', String(hlsTimeSeconds),
            '-hls_list_size', '3',
            '-hls_flags', 'delete_segments',
            '-force_key_frames', `expr:gte(t,n_forced*${hlsTimeSeconds})`,
            '-sc_threshold', '0',
            '-hls_segment_filename', segmentPath,
            '-start_number', '0'
        ])
        .output(playlistPath)
        .on('start', (commandLine) => {
            console.log(`FFmpeg started: ${commandLine}`);
        })
        .on('error', (err) => {
            console.error(`FFmpeg error for stream ${streamId}:`, err.message);
            cleanupStream(streamId);
            finalize(500, { error: 'Failed to start stream - check RTSP URL and credentials' });
        })
        .on('end', () => {
            console.log(`FFmpeg ended for stream ${streamId}`);
            cleanupStream(streamId);
            finalize(500, { error: 'Stream ended before startup completed' });
        });
    
    ffmpegProcess.run();
    
    activeStreams.set(streamId, {
        rtspUrl,
        label: sanitizeText(label, 60),
        notes: sanitizeText(notes, 280),
        ffmpegProcess,
        streamDir,
        playlistPath,
        startTime: Date.now()
    });
    
    pollTimer = setInterval(() => {
        if (fs.existsSync(playlistPath)) {
            upsertSavedStream(rtspUrl, streamId, { label, notes });
            finalize(200, { 
                success: true, 
                streamId,
                label: sanitizeText(label, 60),
                notes: sanitizeText(notes, 280),
                message: 'Stream started successfully'
            });
        }
    }, startupPollMs);

    timeoutTimer = setTimeout(() => {
        cleanupStream(streamId);
        finalize(500, { error: 'Stream startup timed out' });
    }, startupTimeoutMs);
});

app.post('/stop-stream/:streamId', (req, res) => {
    const { streamId } = req.params;
    
    if (activeStreams.has(streamId)) {
        cleanupStream(streamId);
        res.json({ success: true, message: 'Stream stopped' });
    } else {
        res.status(404).json({ error: 'Stream not found' });
    }
});

app.get('/saved-streams', (req, res) => {
    res.json({ streams: savedStreams });
});

app.post('/saved-streams/update', (req, res) => {
    const { rtspUrl, label, notes } = req.body;

    if (!rtspUrl) {
        return res.status(400).json({ error: 'RTSP URL is required' });
    }

    const safeLabel = sanitizeText(label, 60);
    const safeNotes = sanitizeText(notes, 280);
    let existing = savedStreams.find((stream) => stream.rtspUrl === rtspUrl);

    if (!existing) {
        existing = {
            rtspUrl,
            lastStreamId: null,
            lastStartedAt: null,
            label: safeLabel,
            notes: safeNotes,
            screenshots: []
        };
        savedStreams.push(existing);
    } else {
        existing.label = safeLabel;
        existing.notes = safeNotes;
    }

    persistSavedStreams();
    res.json({ success: true, stream: existing });
});

app.post('/screenshot/:streamId', (req, res) => {
    const { streamId } = req.params;
    const streamInfo = activeStreams.get(streamId);

    if (!streamInfo) {
        return res.status(404).json({ error: 'Stream not found' });
    }

    if (!fs.existsSync(streamInfo.playlistPath)) {
        return res.status(400).json({ error: 'Stream playlist not ready' });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${streamId}-${timestamp}.jpg`;
    const filePath = path.join(CAPTURES_DIR, fileName);

    ffmpeg(streamInfo.playlistPath)
        .outputOptions(['-frames:v', '1', '-q:v', '2'])
        .output(filePath)
        .on('end', () => {
            addScreenshotRecord(streamInfo.rtspUrl, streamId, fileName);
            res.json({
                success: true,
                fileName,
                fileUrl: `/captures/${fileName}`
            });
        })
        .on('error', (err) => {
            console.error(`Screenshot error for stream ${streamId}:`, err.message);
            res.status(500).json({ error: 'Failed to capture screenshot' });
        })
        .run();
});

app.get('/stream/:streamId/:file', (req, res) => {
    const { streamId, file } = req.params;
    const streamInfo = activeStreams.get(streamId);
    
    if (!streamInfo) {
        return res.status(404).json({ error: 'Stream not found' });
    }
    
    const filePath = path.join(streamInfo.streamDir, file);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }
    
    if (file.endsWith('.m3u8')) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (file.endsWith('.ts')) {
        res.setHeader('Content-Type', 'video/mp2t');
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
    
    res.sendFile(filePath);
});

app.get('/streams', (req, res) => {
    const streams = Array.from(activeStreams.entries()).map(([id, info]) => ({
        streamId: id,
        rtspUrl: info.rtspUrl,
        startTime: info.startTime,
        uptime: Date.now() - info.startTime
    }));
    
    res.json({ streams });
});

process.on('SIGINT', () => {
    console.log('Shutting down server...');
    
    for (const [streamId] of activeStreams) {
        cleanupStream(streamId);
    }
    
    const streamsDir = path.join(__dirname, 'streams');
    if (fs.existsSync(streamsDir)) {
        fs.rmSync(streamsDir, { recursive: true, force: true });
    }
    
    process.exit(0);
});

const streamsDir = path.join(__dirname, 'streams');
ensureDirectoryExists(streamsDir);
ensureDirectoryExists(CAPTURES_DIR);

app.listen(PORT, () => {
    console.log(`RTSP CCTV Streamer running on http://localhost:${PORT}`);
    console.log('Make sure FFmpeg is installed on your system');
});
