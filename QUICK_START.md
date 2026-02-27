# Quick Start Guide - Responsive Mobile Rendering

## Setup

1. **Start the Server**
```bash
node server.js
```
You should see: `Server running on http://localhost:3000`

2. **Access the Client**
- Open your browser to `http://localhost:3000`
- Or use the ngrok URL for remote access

## Using the New Features

### Selecting a Device

1. Click the **Device** dropdown (first dropdown in header)
2. Choose from:
   - **Auto-detect** (defaults to iPhone 13)
   - **iPhone** models (SE, 11, 12, 13, 14, 15)
   - **Android** phones (Pixel 6, Pixel 7, Galaxy S21, S22)
   - **Tablets** (iPad, iPad Pro)

3. The canvas will immediately update to reflect that device's aspect ratio

### Starting a Session

1. **Select Device** (optional - defaults to iPhone 13)
2. **Select Platform** (Facebook, Instagram, Twitter/X, TikTok, LinkedIn)
3. **Click Start**
4. Wait for connection (status dot turns green)
5. The remote browser will load on the selected platform

### Interacting

- **Click**: Click on the canvas to tap the mobile screen
- **Scroll**: Scroll wheel to scroll the page
- **Type**: Click the text input at the bottom and press Enter
- **Keyboard**: Use keyboard for special keys (only in streaming mode)

### Stopping

Click the **Stop** button to end the session and close the browser context.

## Device Dimensions Reference

| Device | Resolution | Aspect Ratio |
|--------|------------|--------------|
| iPhone SE | 375 × 667 | 0.56 |
| iPhone 11 | 414 × 896 | 0.46 |
| iPhone 12 | 390 × 844 | 0.46 |
| iPhone 13 | 390 × 844 | 0.46 |
| iPhone 14 | 390 × 844 | 0.46 |
| iPhone 15 | 393 × 852 | 0.46 |
| Pixel 6 | 412 × 915 | 0.45 |
| Pixel 7 | 412 × 915 | 0.45 |
| Galaxy S21 | 360 × 800 | 0.45 |
| Galaxy S22 | 360 × 800 | 0.45 |
| iPad | 768 × 1024 | 0.75 |
| iPad Pro | 1024 × 1366 | 0.75 |

## Troubleshooting

### Canvas is too small
- This is normal - the canvas scales to fit your screen while maintaining device aspect ratio
- The actual rendering is at full device resolution
- It will look larger/sharper on a bigger monitor

### Image quality is poor
- Check your network connection
- Quality is set to 90 (excellent balance)
- Give the page a few seconds to stabilize

### Device selection is disabled
- You can't change devices while streaming
- Click **Stop** first, then select a new device

### Connection issues
- Ensure the server is running: `node server.js`
- Check that you're using the correct URL
- If using ngrok, verify the tunnel is still active

## Tips for Best Results

1. **Desktop Viewing**: Watch on a large monitor for best clarity
2. **Mobile Testing**: Test on actual devices to see real-world performance
3. **Network**: High-speed connection recommended for smooth 60 FPS
4. **Device Selection**: Choose the device your users actually use
5. **Full Screen**: Press F11 on desktop for immersive viewing

## Performance Monitoring

- **FPS Display**: Top right shows frames per second
- **Resolution**: Shows actual rendering dimensions
- **Network**: Each frame is typically 30-150 KB at quality 90

## API Details

### /start-session (POST)
```json
{
  "platform": "instagram",
  "device": "iPhone 15",
  "width": 393,
  "height": 852
}
```

Response:
```json
{
  "sessionId": "uuid-here",
  "width": 393,
  "height": 852
}
```

### /end-session (POST)
```json
{
  "sessionId": "uuid-here"
}
```

### WebSocket Messages

**Start Stream:**
```json
{
  "sessionId": "uuid-here",
  "type": "start-stream"
}
```

**Input Events:**
```json
{
  "sessionId": "uuid-here",
  "type": "click",
  "x": 195,
  "y": 422
}
```

---

Happy testing! 🚀
