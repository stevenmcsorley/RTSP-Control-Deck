# RTSP CCTV Camera Streamer

A simple web application for streaming RTSP feeds from CCTV cameras to web browsers using HLS (HTTP Live Streaming).

![RTSP Control Deck](screen.png)

## Prerequisites

- Node.js (v14 or higher)
- FFmpeg installed on your system

### Installing FFmpeg

**Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install ffmpeg
```

**macOS:**
```bash
brew install ffmpeg
```

**Windows:**
Download from https://ffmpeg.org/download.html

## Installation

1. Install dependencies:
```bash
npm install
```

2. Start the server:
```bash
npm start
```

3. Open your browser and go to `http://localhost:3000`

## Usage

1. Enter your RTSP camera URL in the format:
   ```
   rtsp://username:password@camera_ip:port/stream_path
   ```

2. Click "Start Stream" to begin streaming

3. The video will appear in the player once the stream is established

## Common RTSP URL Formats

- Generic: `rtsp://admin:password@192.168.1.100:554/stream1`
- Hikvision: `rtsp://admin:password@192.168.1.100:554/Streaming/Channels/101`
- Dahua: `rtsp://admin:password@192.168.1.100:554/cam/realmonitor?channel=1&subtype=0`
- Axis: `rtsp://root:password@192.168.1.100:554/axis-media/media.amp`

## Features

- Real-time RTSP to HLS conversion
- Web-based interface
- Multiple concurrent streams support
- Automatic cleanup of resources
- Cross-browser compatibility

## API Endpoints

- `POST /start-stream` - Start a new stream
- `POST /stop-stream/:streamId` - Stop a specific stream
- `GET /streams` - List all active streams
- `GET /stream/:streamId/:file` - Serve HLS segments

## Troubleshooting

- Ensure FFmpeg is properly installed and accessible
- Check RTSP URL format and credentials
- Verify camera is accessible from the server
- Some cameras may require specific RTSP transport settings

## Local Dummy RTSP Streams (Testing)

You can spin up local RTSP test feeds (no real cameras) using MediaMTX and FFmpeg.

1) Download and run MediaMTX (RTSP server):
```bash
mkdir -p /tmp/mediamtx
curl -fL -o /tmp/mediamtx/mediamtx.tar.gz https://github.com/bluenviron/mediamtx/releases/download/v1.8.0/mediamtx_v1.8.0_linux_amd64.tar.gz
tar -xzf /tmp/mediamtx/mediamtx.tar.gz -C /tmp/mediamtx
cat <<'EOF' > /tmp/mediamtx/mediamtx.local.yml
rtsp: yes
protocols: [tcp]
rtspAddress: :8554
rtspAuthMethods: [basic]
rtmp: no
hls: no
webrtc: no
srt: no

paths:
  all_others:
EOF
/tmp/mediamtx/mediamtx /tmp/mediamtx/mediamtx.local.yml
```

2) Publish four dummy streams:
```bash
for i in 1 2 3 4; do \
  ffmpeg -re -f lavfi -i "testsrc=size=1280x720:rate=15" \
    -vf "drawtext=text='CAM $i':fontcolor=white:fontsize=48:x=24:y=24:box=1:boxcolor=black@0.5" \
    -pix_fmt yuv420p -c:v libx264 -preset veryfast -tune zerolatency \
    -f rtsp -rtsp_transport tcp "rtsp://localhost:8554/cam$i"; \
done
```

3) Use these URLs in the app:
```
rtsp://localhost:8554/cam1
rtsp://localhost:8554/cam2
rtsp://localhost:8554/cam3
rtsp://localhost:8554/cam4
```

Notes:
- If `drawtext` is unavailable, remove the `-vf` option.
- Stop MediaMTX with Ctrl+C. Stop FFmpeg publishers with Ctrl+C in their terminals.
