"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;

var _sockjsClient = _interopRequireDefault(require("sockjs-client"));

var _nodeFetch = _interopRequireDefault(require("node-fetch"));

var _xml2js = _interopRequireDefault(require("xml2js"));

var _config = _interopRequireDefault(require("../../config"));

var _events = _interopRequireDefault(require("events"));

var _signale = _interopRequireDefault(require("signale"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function asyncGeneratorStep(gen, resolve, reject, _next, _throw, key, arg) { try { var info = gen[key](arg); var value = info.value; } catch (error) { reject(error); return; } if (info.done) { resolve(value); } else { Promise.resolve(value).then(_next, _throw); } }

function _asyncToGenerator(fn) { return function () { var self = this, args = arguments; return new Promise(function (resolve, reject) { var gen = fn.apply(self, args); function _next(value) { asyncGeneratorStep(gen, resolve, reject, _next, _throw, "next", value); } function _throw(err) { asyncGeneratorStep(gen, resolve, reject, _next, _throw, "throw", err); } _next(undefined); }); }; }

_signale.default.config({
  displayTimestamp: true,
  displayDate: true
});

var log = _signale.default.scope("SLOBS");

var parseString = _xml2js.default.parseString;
var ID_CONNECT = 1;
var ID_STREAMSTATUS = 2;
var ID_STREAMSTATUS_CHANGED = 3;
var ID_SCENE_CHANGED = 3;
var ID_SCENES = 4;
var ID_TOGGLE = 5;
var ID_ACTIVE = 8;

class SlobsSwitcher extends _events.default {
  constructor(address, password, low, normal, offline, lowBitrateTrigger) {
    var highRttTrigger = arguments.length > 6 && arguments[6] !== undefined ? arguments[6] : 2500;
    super();
    this.obs = new _sockjsClient.default("http://".concat(address, "/api"));
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
    var connectMessage = JSON.stringify({
      jsonrpc: '2.0',
      id: ID_CONNECT,
      method: 'auth',
      params: {
        resource: 'TcpServerService',
        args: [this.password]
      }
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
          for (var i = 0; i < data.result.length; i++) {
            var sceneName = data.result[i].name;
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

      if (data.result._type !== undefined && data.result._type === 'EVENT') {
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

          if (data.result.data == 'live') {
            this.recordStarted();
          } else if (data.result.data == 'offline') {
            this.recordStopped();
          }
        }
      }
    };

    this.obs.onclose = () => {
      this.onDisconnect();
    }; //this.obs.on("Heartbeat", this.handleHeartbeat.bind(this));
    //this.obs.on("ScenesChanged", this.scenesChanged.bind(this));


    log.info("Connecting & authenticating");
  }

  switchSceneIfNecessary() {
    var _this = this;

    return _asyncToGenerator(function* () {
      if (!_this.obsStreaming && (_config.default.obs.onlySwitchWhenStreaming == null || _config.default.obs.onlySwitchWhenStreaming)) return;
      var [bitrate, rtt] = yield _this.getBitrate();
      var {
        currentScene,
        canSwitch
      } = yield _this.canSwitch();

      if (bitrate !== null) {
        _this.isLive = true;

        if (["nimble", "srt-live-server"].includes(_config.default.rtmp.server)) {
          _this.isLive && canSwitch && (bitrate === 0 && currentScene.name !== _this.previousScene && (_this.switchScene(_this.previousScene), _this.switchSceneEmit("live", _this.previousScene), log.info("Stream went online switching to scene: \"".concat(_this.previousScene, "\""))), (rtt < _this.highRttTrigger || rtt >= _this.highRttTrigger) && bitrate <= _this.lowBitrateTrigger && currentScene.name !== _this.lowBitrateScene && bitrate !== 0 && (_this.switchScene(_this.lowBitrateScene), _this.previousScene = _this.lowBitrateScene, _this.switchSceneEmit("lowBitrateScene"), log.info("Low bitrate detected switching to scene: \"".concat(_this.lowBitrateScene, "\""))), rtt >= _this.highRttTrigger && bitrate > _this.lowBitrateTrigger && currentScene.name !== _this.lowBitrateScene && bitrate !== 0 && (_this.switchScene(_this.lowBitrateScene), _this.previousScene = _this.lowBitrateScene, _this.switchSceneEmit("lowBitrateScene"), log.info("High RTT detected switching to scene: \"".concat(_this.lowBitrateScene, "\""))), rtt < _this.highRttTrigger && bitrate > _this.lowBitrateTrigger && currentScene.name !== _this.normalScene && (_this.switchScene(_this.normalScene), _this.previousScene = _this.normalScene, _this.switchSceneEmit("normalScene"), log.info("Switching to normal scene: \"".concat(_this.normalScene, "\""))));
        } else {
          _this.isLive && canSwitch && (bitrate === 0 && currentScene.name !== _this.previousScene && (_this.switchScene(_this.previousScene), _this.switchSceneEmit("live", _this.previousScene), log.info("Stream went online switching to scene: \"".concat(_this.previousScene, "\""))), bitrate <= _this.lowBitrateTrigger && currentScene.name !== _this.lowBitrateScene && bitrate !== 0 && (_this.switchScene(_this.lowBitrateScene), _this.previousScene = _this.lowBitrateScene, _this.switchSceneEmit("lowBitrateScene"), log.info("Low bitrate detected switching to scene: \"".concat(_this.lowBitrateScene, "\""))), bitrate > _this.lowBitrateTrigger && currentScene.name !== _this.normalScene && (_this.switchScene(_this.normalScene), _this.previousScene = _this.normalScene, _this.switchSceneEmit("normalScene"), log.info("Switching to normal scene: \"".concat(_this.normalScene, "\""))));
        }
      } else {
        _this.isLive = false;
        canSwitch && currentScene.name !== _this.offlineScene && (_this.switchScene(_this.offlineScene), _this.switchSceneEmit("offlineScene"), _this.streamStatus = null, log.warn("Error receiving current bitrate or stream is offline. Switching to offline scene: \"".concat(_this.offlineScene, "\"")));
      }
    })();
  }

  subscribeStreaming() {
    var message = JSON.stringify({
      id: ID_STREAMSTATUS_CHANGED,
      jsonrpc: '2.0',
      method: 'streamingStatusChange',
      params: {
        resource: 'StreamingService'
      }
    });
    this.obs.send(message);
    message = JSON.stringify({
      id: ID_SCENE_CHANGED,
      jsonrpc: '2.0',
      method: 'sceneSwitched',
      params: {
        resource: 'ScenesService'
      }
    });
    this.obs.send(message);
    message = JSON.stringify({
      id: ID_STREAMSTATUS_CHANGED,
      jsonrpc: '2.0',
      method: 'recordingStatusChange',
      params: {
        resource: 'StreamingService'
      }
    });
    this.obs.send(message);
  }

  onAuth() {
    log.success("Successfully connected"); //this.obs.send("SetHeartbeat", { enable: true });

    this.subscribeStreaming();
    this.getScenes();
    this.interval = setInterval(this.switchSceneIfNecessary.bind(this), _config.default.obs.requestMs);
  }

  switchSceneEmit(sceneName, args) {
    if (_config.default.twitchChat.enableAutoSwitchNotification && this.obsStreaming) {
      this.emit(sceneName, args);
    }
  }

  getBitrate() {
    var _this2 = this;

    return _asyncToGenerator(function* () {
      var {
        server,
        stats,
        application,
        key,
        id,
        publisher
      } = _config.default.rtmp;

      switch (server) {
        case "nginx":
          try {
            var response = yield (0, _nodeFetch.default)(stats);
            var data = yield response.text();
            parseString(data, (err, result) => {
              var publish = result.rtmp.server[0].application.find(stream => {
                return stream.name[0] === application;
              }).live[0].stream;
              var stream = publish === null || publish === void 0 ? void 0 : publish.find(stream => {
                return stream.name[0] === key;
              });

              if (stream != null) {
                _this2.nginxVideoMeta = stream.meta[0].video[0];
                _this2.bitrate = Math.round(stream.bw_video[0] / 1024);
              } else {
                _this2.nginxVideoMeta = null;
                _this2.bitrate = null;
              }
            });
          } catch (e) {
            log.error("[NGINX] Error fetching stats");
          }

          break;

        case "node-media-server":
          try {
            var _response = yield (0, _nodeFetch.default)("".concat(stats, "/").concat(application, "/").concat(key));

            var _data = yield _response.json();

            _this2.bitrate = _data.bitrate || null;
          } catch (e) {
            log.error("[NMS] Error fetching stats, is the API http server running?");
          }

          break;

        case "nimble":
          try {
            // SRT stats to see RTT and if streaming is active
            var srtresponse = yield (0, _nodeFetch.default)(stats + "/manage/srt_receiver_stats");
            var srtdata = yield srtresponse.json();
            var srtreceiver = srtdata.SrtReceivers.filter(receiver => receiver.id == id);
            var publish = srtreceiver[0].state;

            if (publish == "disconnected") {
              _this2.bitrate = null;
              _this2.rtt = null;
            } else {
              // RTMP status for bitrate. srt_receiver_stats seems to give an averaged number that isn't as useful.
              // Probably requires nimble to be configured to make the video from SRT available on RTMP even though it's not used anywhere
              var rtmpresponse = yield (0, _nodeFetch.default)(stats + "/manage/rtmp_status");
              var rtmpdata = yield rtmpresponse.json();
              var rtmpstream = rtmpdata.filter(rtmp => rtmp.app == application)[0].streams.filter(stream => stream.strm == key);
              _this2.bitrate = Math.round(rtmpstream[0].bandwidth / 1024);
              _this2.rtt = srtreceiver[0].stats.link.rtt;
            }
          } catch (e) {
            log.error("[NIMBLE] Error fetching stats: " + e);
          }

          break;

        case "srt-live-server":
          try {
            var _stream$rtt;

            var _srtresponse = yield (0, _nodeFetch.default)(stats);

            var _srtdata = yield _srtresponse.json();

            var stream = _srtdata.publishers[publisher];
            _this2.bitrate = (stream === null || stream === void 0 ? void 0 : stream.bitrate) || null;
            _this2.rtt = (_stream$rtt = stream === null || stream === void 0 ? void 0 : stream.rtt) !== null && _stream$rtt !== void 0 ? _stream$rtt : null;
          } catch (e) {
            log.error("[SLS] Error fetching stats: " + e);
          }

          break;

        default:
          log.error("[STATS] Something went wrong at getting the RTMP server, did you enter the correct name in the config?");
          break;
      }

      return [_this2.bitrate, _this2.rtt];
    })();
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

  streamStopped() {
    var _this3 = this;

    return _asyncToGenerator(function* () {
      _this3.obsStreaming = false;
      _this3.nginxVideoMeta = null;
      _this3.bitrate = null;
      var {
        canSwitch
      } = yield _this3.canSwitch();

      if (canSwitch) {
        _this3.switchScene(_this3.offlineScene);
      }
    })();
  }

  recordingStopped() {
    var _this4 = this;

    return _asyncToGenerator(function* () {
      _this4.obsRecording = false;
    })();
  }

  streamStarted() {
    this.obsStreaming = true;
  }

  recordingStarted() {
    this.obsRecording = true;
  }

  getScenes() {
    var message = JSON.stringify({
      id: ID_SCENES,
      jsonrpc: '2.0',
      method: 'getScenes',
      params: {
        resource: 'ScenesService'
      }
    });
    this.obs.send(message);
  }

  getSceneList() {
    var _this5 = this;

    return _asyncToGenerator(function* () {
      return _this5.scenes;
    })();
  }

  scenesChanged() {
    this.getSceneList();
  }

  handleHeartbeat(heartbeat) {
    this.heartbeat = heartbeat;
    this.obsStreaming = heartbeat.streaming;
  }

  switchScene(sceneName) {
    var scene = this.scenes.get(sceneName);
    var message = JSON.stringify({
      id: 10,
      jsonrpc: '2.0',
      method: 'makeSceneActive',
      params: {
        resource: 'ScenesService',
        args: [scene.id]
      }
    });
    this.obs.send(message);
  }

  getSlobsActiveScene() {
    var message = JSON.stringify({
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
    var message = JSON.stringify({
      jsonrpc: '2.0',
      id: ID_TOGGLE,
      method: 'toggleStreaming',
      params: {
        resource: 'StreamingService'
      }
    });
    this.obs.send(message);
  }

  toggleRecording() {
    var message = JSON.stringify({
      jsonrpc: '2.0',
      id: ID_TOGGLE,
      method: 'toggleRecording',
      params: {
        resource: 'StreamingService'
      }
    });
    this.obs.send(message);
  }

  canSwitch() {
    var _this6 = this;

    return _asyncToGenerator(function* () {
      var currentScene = _this6.currentScene;
      var canSwitch = currentScene.name == _this6.lowBitrateScene || currentScene.name == _this6.normalScene || currentScene.name == _this6.offlineScene;
      return {
        currentScene,
        canSwitch
      };
    })();
  }

}

var _default = SlobsSwitcher;
exports.default = _default;