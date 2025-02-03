Promise = require("bluebird");
const EventEmitter = require("events");
const path = require("path");
const adb = require("adbkit");
const net = require("net");
const PromiseSocket = require("promise-socket").PromiseSocket;
const debug = require("debug")("scrcpy");

/**

How scrcpy works?
Its a jar file that runs on an adb shell. It records the screen in h264 and offers it in a given tcp port.
scrcpy params
maxSize (integer, multiple of 8) 0
bitRate (integer)
tunnelForward (optional, bool) use "adb forward" instead of "adb tunnel"
crop (optional, string) "width:height:x:y"
sendFrameMeta (optional, bool)
The video stream contains raw packets, without time information. If sendFrameMeta is enabled a meta header is added
before each packet.
The "meta" header length is 12 bytes
[. . . . . . . .|. . . .]. . . . . . . . . . . . . . . ...
<------------
---
----------------------------...
PTS size raw packet (of size len)
*/
class Scrcpy extends EventEmitter {
  constructor(config, port) {
    super();
    this._config = Object.assign(
      {
        adbHost: "localhost",
        adbPort: 5037,
        deviceId: config,
        port: port,
        maxSize: 1024,
        bitrate: 2000000,
        tunnelForward: true,
        tunnelDelay: 3000,
        crop: "9999:9999:0:0",
        sendFrameMeta: true,
      },
      config
    );

    this.adbClient = adb.createClient({
      host: this._config.adbHost,
      port: this._config.adbPort,
    });
  }

  /**
   * Will connect to the android device, send & run the server and return deviceName, width and height.
   * After that data will be offered as a 'data' event.
   */
  async start() {
    const devices = await this.adbClient.listDevices().catch((e) => {
      debug("Impossible to list devices:", e);
      throw e;
    });

    const device = this._config.deviceId
      ? devices.find((d) => d.id === this._config.deviceId)
      : devices[0];
    if (!device) {
      throw new Error(
        this._config.deviceId
          ? `Device ${this._config.deviceId} not found in adb`
          : "No device present in adb server"
      );
    }

    // Transfer server...
    await this.adbClient
      .push(
        device.id,
        path.join(__dirname, "scrcpy-server.jar"),
        "/data/local/tmp/scrcpy-server.jar"
      )
      .then(
        (transfer) =>
          new Promise((resolve, reject) => {
            transfer.on("progress", (stats) => {
              debug(
                "[%s] Pushed %d bytes so far",
                device.id,
                stats.bytesTransferred
              );
            });
            transfer.on("end", () => {
              debug("[%s] Push complete", device.id);
              resolve();
            });
            transfer.on("error", reject);
          })
      )
      .catch((e) => {
        debug("Impossible to transfer server file:", e);
        throw e;
      });

    // Run server
    await this.adbClient
      .shell(
        device.id,
        "CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / " +
          `com.genymobile.scrcpy.Server 2.7 max_size=${this._config.maxSize} bit_rate=${this._config.bitrate} tunnel_forward=${this._config.tunnelForward} ` +
          `crop=${this._config.crop} send_frame_meta=${this._config.sendFrameMeta} audio=false control=false`
      )
      .catch((e) => {
        debug("Impossible to run server:", e);
        throw e;
      });

    await this.adbClient
      .forward(device.id, `tcp:${this._config.port}`, "localabstract:scrcpy")
      .catch((e) => {
        debug(`Impossible to forward port ${this._config.port}:`, e);
        throw e;
      });

    this.socket = new PromiseSocket(new net.Socket());

    // Wait 1 sec to forward to work
    await Promise.delay(this._config.tunnelDelay);

    // Connect
    await this.socket.connect(this._config.port, "127.0.0.1").catch((e) => {
      debug(`Impossible to connect "127.0.0.1:${this._config.port}":`, e);
      throw e;
    });
    // Read initial metadata
    console.log("Reading initial metadata...");

    // Read dummy byte
    const dummyByte = await this.socket.read(1);
    if (!dummyByte) {
      throw new Error("Failed to read dummy byte");
    }
    console.log("Dummy byte:", dummyByte[0]);

    // Read device name (64 bytes)
    const deviceNameBuf = await this.socket.read(64);
    if (!deviceNameBuf) {
      throw new Error("Failed to read device name");
    }
    const name = deviceNameBuf.toString("utf8").replace(/\0/g, "");
    console.log("Device name:", name);

    // Read codec metadata (12 bytes)
    const codecMeta = await this.socket.read(12);
    if (!codecMeta) {
      throw new Error("Failed to read codec metadata");
    }

    const codecId = codecMeta.readUInt32BE(0);
    const width = codecMeta.readUInt32BE(4);
    const height = codecMeta.readUInt32BE(8);

    // Validate dimensions
    if (width > 8192 || height > 8192) {
      throw new Error(`Invalid dimensions: ${width}x${height}`);
    }

    console.log("Codec info:", { codecId, width, height });

    if (this._config.sendFrameMeta) {
      this._startStreamWithMeta();
    } else {
      this._startStreamRaw();
    }

    return { name, width, height, codecId };
  }

  stop() {
    if (this.socket) {
      this.socket.destroy();
    }
  }

  _startStreamWithMeta() {
    let remainingData = Buffer.alloc(0);
    const HEADER_SIZE = 12;

    this.socket.stream.on("readable", () => {
      try {
        let chunk;
        while (null !== (chunk = this.socket.stream.read())) {
          // Combine with remaining data
          const data = Buffer.concat([remainingData, chunk]);
          let offset = 0;

          while (offset + HEADER_SIZE <= data.length) {
            // Read header
            const pts = data.readBigUInt64BE(offset);
            const packetSize = data.readUInt32BE(offset + 8);

            // Validate packet size
            if (packetSize > 1024 * 1024 * 1024) {
              // 1GB limit
              console.error(`Invalid packet size: ${packetSize}`);
              offset += HEADER_SIZE;
              continue;
            }

            // Check if we have the complete packet
            if (offset + HEADER_SIZE + packetSize > data.length) {
              remainingData = data.slice(offset);
              break;
            }

            // Extract packet
            const packetData = data.slice(
              offset + HEADER_SIZE,
              offset + HEADER_SIZE + packetSize
            );

            // Parse PTS flags
            const isConfig = Boolean(pts & BigInt("0x8000000000000000"));
            const isKeyFrame = Boolean(pts & BigInt("0x4000000000000000"));
            const timestamp = Number(pts & BigInt("0x3FFFFFFFFFFFFFFF"));

            // Emit packet
            this.emit("data", timestamp, packetData, isConfig, isKeyFrame);

            // Move to next packet
            offset += HEADER_SIZE + packetSize;
          }

          // Keep any remaining data
          if (offset < data.length) {
            remainingData = data.slice(offset);
          } else {
            remainingData = Buffer.alloc(0);
          }
        }
      } catch (error) {
        console.error("Error processing video stream:", error);
        this.emit("error", error);
      }
    });

    this.socket.stream.on("error", (error) => {
      console.error("Socket error:", error);
      this.emit("error", error);
    });

    this.socket.stream.on("end", () => {
      console.log("Stream ended");
      this.emit("end");
    });
  }

  _startStreamRaw() {
    this.socket.stream.on("data", (data) =>
      this.emit("data", 0, data, false, false)
    );
  }
}

module.exports = Scrcpy;
