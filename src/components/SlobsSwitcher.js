import SockJS from "sockjs-client";
import fetch from "node-fetch";
import xml2js from "xml2js";
import config from "../../config";
import EventEmitter from "events";
import signale from "signale";

signale.config({
    displayTimestamp: true,
    displayDate: true,
});

const log = signale.scope("SLOBS");
const parseString = xml2js.parseString;

const ID_CONNECT = 1;
const ID_STREAMSTATUS = 2;
const ID_STREAMSTATUS_CHANGED = 3;
const ID_SCENE_CHANGED = 3;
const ID_SCENES = 4;
const ID_TOGGLE = 5;
const ID_ACTIVE = 8;
class SlobsSwitcher extends EventEmitter {
    constructor(
        address,
        password,
        low,
        normal,
        offline,
        lowBitrateTrigger,
        highRttTrigger = 2500
    ) {
        super();
        this.obs = new SockJS(`http://${address}/api`);
        this.isLive = false;
        this.address = address;
        this.password = password;
        this.lowBitrateScene = low;
        this.normalScene = normal;
        this.offlineScene = offline;
        this.lowBitrateTrigger = lowBitrateTrigger;
        this.highRttTrigger = highRttTrigger;
        this.bitrate = null;
        this.nginxVideoMeta = null;
        this.streamStatus = null;
        this.recordingStatus = null;
        this.heartbeat = null;
        this.obsStreaming = false;
        this.obsRecording = false;
        this.currentScene = {};
        this.nginxSettings;
        this.previousScene = this.lowBitrateScene;
        this.scenes = new Map();

        const connectMessage = JSON.stringify({
            jsonrpc: '2.0',
            id: ID_CONNECT,
            method: 'auth',
            params: {
                resource: 'TcpServerService',
                args: [this.password],
            },
        });

        this.obs.onopen = () => {
            console.log('===> Connected Successfully to Streamlabs');
            this.obs.send(connectMessage);
            this.getSlobsActiveScene();
        };

        this.obs.onmessage = e => {
            // Parse JSON Data
            var data = JSON.parse(e.data);
            switch (data.id) {
                case ID_SCENES:
                    for (let i = 0; i < data.result.length; i++) {
                        const sceneName = data.result[i].name;
                        this.scenes.set(sceneName, data.result[i]);
                    }
                    this.scenesChanged();
                    break;
                case ID_STREAMSTATUS:
                    this.setStreamStatus(data.result.streamingStatus);
                    this.setRecordingStatus(data.result.recordingStatus);
                    break;
                case ID_ACTIVE:
                    this.currentScene = data.result;
                    break;
                case ID_CONNECT:
                    if (data.result) {
                        if (data.error) {
                            this.error(data.error.message);
                            this.onAuthFail();
                            return;
                        }
                        this.onAuth();
                    }
                    break;
            }
            if (data && data.result && data.result._type !== undefined && data.result._type === 'EVENT') {
                if (data.result.emitter === 'STREAM' && data.result.resourceId === 'ScenesService.sceneSwitched') {
                    this.currentScene = data.result.data;
                }
                if (data.result.emitter === 'STREAM' && data.result.resourceId === 'StreamingService.streamingStatusChange') {
                    this.setStreamStatus(data.result.data);
                    if (data.result.data == 'live') {
                        this.streamStarted();
                    } else if (data.result.data == 'offline') {
                        this.streamStopped();
                    }
                }
                if (data.result.emitter === 'STREAM' && data.result.resourceId === 'StreamingService.recordingStatusChange') {
                    this.setRecordingStatus(data.result.data);
                    if (data.result.data == 'recording') {
                        this.recordStarted();
                    } else if (data.result.data == 'offline') {
                        this.recordStopped();
                    }
                }
            }

        };

        this.obs.onclose = () => {
            this.onDisconnect();
        };

        //this.obs.on("Heartbeat", this.handleHeartbeat.bind(this));
        //this.obs.on("ScenesChanged", this.scenesChanged.bind(this));

        log.info("Connecting & authenticating");
    }

    async switchSceneIfNecessary() {
        if (
            !this.obsStreaming &&
            (config.obs.onlySwitchWhenStreaming == null ||
                config.obs.onlySwitchWhenStreaming)
        )
            return;

        const [bitrate, rtt] = await this.getBitrate();
        const {currentScene, canSwitch} = await this.canSwitch();

        if (bitrate !== null) {
            this.isLive = true;

            if (["nimble", "srt-live-server"].includes(config.rtmp.server)) {
                this.isLive &&
                    canSwitch &&
                    (bitrate === 0 &&
                        currentScene.name !== this.previousScene &&
                        (this.switchScene(this.previousScene),
                        this.switchSceneEmit("live", this.previousScene),
                        log.info(
                            `Stream went online switching to scene: "${this.previousScene}"`
                        )),
                    (rtt < this.highRttTrigger || rtt >= this.highRttTrigger) &&
                        bitrate <= this.lowBitrateTrigger &&
                        currentScene.name !== this.lowBitrateScene &&
                        bitrate !== 0 &&
                        (this.switchScene(this.lowBitrateScene),
                        (this.previousScene = this.lowBitrateScene),
                        this.switchSceneEmit("lowBitrateScene"),
                        log.info(
                            `Low bitrate detected switching to scene: "${this.lowBitrateScene}"`
                        )),
                    rtt >= this.highRttTrigger &&
                        bitrate > this.lowBitrateTrigger &&
                        currentScene.name !== this.lowBitrateScene &&
                        bitrate !== 0 &&
                        (this.switchScene(this.lowBitrateScene),
                        (this.previousScene = this.lowBitrateScene),
                        this.switchSceneEmit("lowBitrateScene"),
                        log.info(
                            `High RTT detected switching to scene: "${this.lowBitrateScene}"`
                        )),
                    rtt < this.highRttTrigger &&
                        bitrate > this.lowBitrateTrigger &&
                        currentScene.name !== this.normalScene &&
                        (this.switchScene(this.normalScene),
                        (this.previousScene = this.normalScene),
                        this.switchSceneEmit("normalScene"),
                        log.info(
                            `Switching to normal scene: "${this.normalScene}"`
                        )));
            } else {
                this.isLive &&
                    canSwitch &&
                    (bitrate === 0 &&
                        currentScene.name !== this.previousScene &&
                        (this.switchScene(this.previousScene),
                        this.switchSceneEmit("live", this.previousScene),
                        log.info(
                            `Stream went online switching to scene: "${this.previousScene}"`
                        )),
                    bitrate <= this.lowBitrateTrigger &&
                        currentScene.name !== this.lowBitrateScene &&
                        bitrate !== 0 &&
                        (this.switchScene(this.lowBitrateScene),
                        (this.previousScene = this.lowBitrateScene),
                        this.switchSceneEmit("lowBitrateScene"),
                        log.info(
                            `Low bitrate detected switching to scene: "${this.lowBitrateScene}"`
                        )),
                    bitrate > this.lowBitrateTrigger &&
                        currentScene.name !== this.normalScene &&
                        (this.switchScene(this.normalScene),
                        (this.previousScene = this.normalScene),
                        this.switchSceneEmit("normalScene"),
                        log.info(
                            `Switching to normal scene: "${this.normalScene}"`
                        )));
            }
        } else {
            this.isLive = false;
            canSwitch &&
                currentScene.name !== this.offlineScene &&
                (this.switchScene(this.offlineScene),
                this.switchSceneEmit("offlineScene"),
                (this.streamStatus = null),
                log.warn(
                    `Error receiving current bitrate or stream is offline. Switching to offline scene: "${this.offlineScene}"`
                ));
        }
    }

    subscribeStreaming() {
        let message = JSON.stringify({
            id: ID_STREAMSTATUS_CHANGED,
            jsonrpc: '2.0',
            method: 'streamingStatusChange',
            params: {resource: 'StreamingService'},
        });
        this.obs.send(message);

        message = JSON.stringify({
            id: ID_SCENE_CHANGED,
            jsonrpc: '2.0',
            method: 'sceneSwitched',
            params: {resource: 'ScenesService'},
        });
        this.obs.send(message);

        message = JSON.stringify({
            id: ID_STREAMSTATUS_CHANGED,
            jsonrpc: '2.0',
            method: 'recordingStatusChange',
            params: {resource: 'StreamingService'},
        });
        this.obs.send(message);
    }

    onAuth() {
        log.success(`Successfully connected`);
        //this.obs.send("SetHeartbeat", { enable: true });
        this.subscribeStreaming();
        this.getScenes();

        this.interval = setInterval(
            this.switchSceneIfNecessary.bind(this),
            config.obs.requestMs
        );
    }

    switchSceneEmit(sceneName, args) {
        if (
            config.twitchChat.enableAutoSwitchNotification &&
            this.obsStreaming
        ) {
            this.emit(sceneName, args);
        }
    }

    async getBitrate() {
        const {server, stats, application, key, id, publisher} = config.rtmp;

        switch (server) {
            case "nginx":
                try {
                    const response = await fetch(stats);
                    const data = await response.text();

                    parseString(data, (err, result) => {
                        const publish = result.rtmp.server[0].application.find(
                            (stream) => {
                                return stream.name[0] === application;
                            }
                        ).live[0].stream;

                        const stream = publish?.find((stream) => {
                            return stream.name[0] === key;
                        });

                        if (stream != null) {
                            this.nginxVideoMeta = stream.meta[0].video[0];
                            this.bitrate = Math.round(
                                stream.bw_video[0] / 1024
                            );
                        } else {
                            this.nginxVideoMeta = null;
                            this.bitrate = null;
                        }
                    });
                } catch (e) {
                    log.error("[NGINX] Error fetching stats");
                }
                break;

            case "node-media-server":
                try {
                    const response = await fetch(
                        `${stats}/${application}/${key}`
                    );
                    const data = await response.json();

                    this.bitrate = data.bitrate || null;
                } catch (e) {
                    log.error(
                        "[NMS] Error fetching stats, is the API http server running?"
                    );
                }
                break;

            case "nimble":
                try {
                    // SRT stats to see RTT and if streaming is active
                    const srtresponse = await fetch(
                        stats + "/manage/srt_receiver_stats"
                    );
                    const srtdata = await srtresponse.json();
                    const srtreceiver = srtdata.SrtReceivers.filter(
                        (receiver) => receiver.id == id
                    );
                    const publish = srtreceiver[0].state;

                    if (publish == "disconnected") {
                        this.bitrate = null;
                        this.rtt = null;
                    } else {
                        // RTMP status for bitrate. srt_receiver_stats seems to give an averaged number that isn't as useful.
                        // Probably requires nimble to be configured to make the video from SRT available on RTMP even though it's not used anywhere
                        const rtmpresponse = await fetch(
                            stats + "/manage/rtmp_status"
                        );
                        const rtmpdata = await rtmpresponse.json();
                        const rtmpstream = rtmpdata
                            .filter((rtmp) => rtmp.app == application)[0]
                            .streams.filter((stream) => stream.strm == key);
                        this.bitrate = Math.round(
                            rtmpstream[0].bandwidth / 1024
                        );
                        this.rtt = srtreceiver[0].stats.link.rtt;
                    }
                } catch (e) {
                    log.error("[NIMBLE] Error fetching stats: " + e);
                }
                break;

            case "srt-live-server":
                try {
                    const srtresponse = await fetch(stats);
                    const srtdata = await srtresponse.json();
                    const stream = srtdata.publishers[publisher];

                    this.bitrate = stream?.bitrate || null;
                    this.rtt = stream?.rtt ?? null;
                } catch (e) {
                    log.error("[SLS] Error fetching stats: " + e);
                }
                break;

            default:
                log.error(
                    "[STATS] Something went wrong at getting the RTMP server, did you enter the correct name in the config?"
                );
                break;
        }

        return [this.bitrate, this.rtt];
    }

    setStreamStatus(res) {
        this.streamStatus = res;
    }

    setRecordingStatus(res) {
        this.recordingStatus = res;
    }

    error(e) {
        log.error(e);
    }

    onDisconnect() {
        log.error("Can't connect or lost connnection");
        clearInterval(this.interval);

        this.reconnect();
    }

    onAuthFail() {
        log.error("Failed to authenticate");
    }

    reconnect() {
        /*log.info("Trying to reconnect in 5 seconds");
        setTimeout(() => {
            this.obs.connect();
        }, 5000);*/
    }

    async streamStopped() {
        this.obsStreaming = false;
        this.nginxVideoMeta = null;
        this.bitrate = null;

        const {canSwitch} = await this.canSwitch();

        if (canSwitch) {
            this.switchScene(this.offlineScene);
        }
    }

    async recordStopped() {
        this.obsRecording = false;
    }


    streamStarted() {
        this.obsStreaming = true;
    }

    recordStarted() {
        this.obsRecording = true;
    }

    getScenes() {
        const message = JSON.stringify({
            id: ID_SCENES,
            jsonrpc: '2.0',
            method: 'getScenes',
            params: {resource: 'ScenesService'},
        });
        this.obs.send(message);
    }

    async getSceneList() {
        return this.scenes;
    }

    scenesChanged() {
        this.getSceneList();
    }

    handleHeartbeat(heartbeat) {
        this.heartbeat = heartbeat;
        this.obsStreaming = heartbeat.streaming;
    }

    switchScene(sceneName) {
        const scene = this.scenes.get(sceneName);
        console.log('scene', scene);
        if (!scene || !scene.id) return;
        const message = JSON.stringify({
            id: 10,
            jsonrpc: '2.0',
            method: 'makeSceneActive',
            params: {resource: 'ScenesService', args: [scene.id]},
        });
        this.obs.send(message);
    }

    getSlobsActiveScene() {
        const message = JSON.stringify({
            jsonrpc: '2.0',
            id: ID_ACTIVE,
            method: 'activeScene',
            params: {
                resource: 'ScenesService'
            }
        });
        this.obs.send(message);
    }

    toggleStreaming() {
        const message = JSON.stringify({
            jsonrpc: '2.0',
            id: ID_TOGGLE,
            method: 'toggleStreaming',
            params: { resource: 'StreamingService' },
        });
        this.obs.send(message);
    }

    toggleRecording() {
        const message = JSON.stringify({
            jsonrpc: '2.0',
            id: ID_TOGGLE,
            method: 'toggleRecording',
            params: { resource: 'StreamingService' },
        });
        this.obs.send(message);
    }

    async canSwitch() {
        const currentScene = this.currentScene;
        const canSwitch =
            currentScene.name == this.lowBitrateScene ||
            currentScene.name == this.normalScene ||
            currentScene.name == this.offlineScene;

        return {currentScene, canSwitch};
    }
}

export default SlobsSwitcher;
