import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons as Commons
import "lib/format.mjs" as Format

// Long-lived service (manifest: kinds "service", keepLoaded). Owns the Deno
// helper process that holds the MQTT connections and the history store, so
// MQTT keeps running whether or not any bar widget or panel exists.
//
// Bar widgets (one per screen) read state from here and call its functions.
// Every string that comes from MQTT is displayed with Text.PlainText.
Item {
  id: root

  // Set by the shell after creation (see PluginShellApi).
  property var shell: null
  property var manifest: null

  readonly property string pluginId: "odach.mqtt-notifier"
  readonly property string pluginDir: String(Qt.resolvedUrl(".")).replace(/^file:\/\//, "").replace(/\/+$/, "")
  readonly property string home: Quickshell.env("HOME") || ""
  readonly property string configDir: (Quickshell.env("XDG_CONFIG_HOME") || home + "/.config") + "/omarchy/mqtt-notifier"
  readonly property string stateDir: (Quickshell.env("XDG_STATE_HOME") || home + "/.local/state") + "/omarchy/mqtt-notifier"

  // ---- settings: the widget's inline entry in shell.json (manifest schema) ----
  readonly property var settings: Format.findEntrySettings(shell ? shell.barConfig : null, pluginId)
  readonly property int initialCount: Format.clampInt(settings.initialMessageCount, 10, 1, 200)
  readonly property int loadMoreCount: Format.clampInt(settings.loadMoreCount, 10, 1, 200)
  readonly property int maxStored: Format.clampInt(settings.maxStoredMessages, 1000, 1, 100000)
  readonly property int popupWidth: Format.clampInt(settings.popupWidth, 380, 280, 1200)
  readonly property int popupMaxHeight: Format.clampInt(settings.popupMaxHeight, 600, 200, 2000)
  readonly property bool desktopNotifications: settings.desktopNotifications !== false
  readonly property bool showUnreadCounter: settings.showUnreadCounter !== false
  readonly property bool markReadOnOpen: settings.markReadOnOpen !== false

  // ---- state published to the widgets ----
  property bool helperReady: false
  property string helperError: ""
  property var brokers: []
  readonly property var brokerWarnings: Format.brokerWarnings(brokers)
  property var configProblems: []
  property string configError: ""
  readonly property string configPath: configDir + "/config.json"
  property int unread: 0
  property int total: 0
  readonly property bool hasMore: items.count < total
  property bool loading: false
  property string lastWarning: ""
  property int openPanels: 0

  property ListModel items: ListModel {}

  Commons.Translations {
    id: translations
    directory: Qt.resolvedUrl("i18n")
  }

  // A helper warning (parser error, notify-send failure) is a hint, not a
  // state: it fades from the panel footer after a while.
  Timer {
    id: warningTimer
    interval: 10 * 60 * 1000
    onTriggered: root.lastWarning = ""
  }

  // Bumped on every config reload so an open settings window can refresh.
  property int configRevision: 0

  // A widget on the focused screen opens its panel (desktop notification click).
  // `shell.summon` cannot be used for this: with a "panel" entry point the
  // shell routes summon to the settings window.
  signal panelRequested()

  // ---- helper process ----
  property int nextRequestId: 1
  property var pending: ({})
  property int restartAttempt: 0
  property bool stopping: false

  Process {
    id: helper
    command: ["bash", root.pluginDir + "/helper/start.sh", root.configDir, root.stateDir,
      "--max-stored", String(root.maxStored)].concat(root.desktopNotifications ? [] : ["--no-desktop-notifications"])
    stdinEnabled: true

    stdout: SplitParser {
      onRead: data => root.handleLine(data)
    }
    // The helper logs to stderr and to <state>/logs/helper.log; keep the
    // shell log quiet and surface warnings through "log" events instead.
    stderr: SplitParser {
      onRead: data => {}
    }

    onExited: (exitCode, exitStatus) => {
      root.helperReady = false
      root.failPending("helper exited")
      if (root.stopping) return
      if (exitCode === 127) return // deno missing: the fatal event explained it; don't spin
      if (root.helperError === "") root.helperError = "MQTT helper stopped (exit " + exitCode + "); restarting"
      restartTimer.interval = Math.min(60000, 2000 * Math.pow(2, Math.min(root.restartAttempt, 5)))
      root.restartAttempt++
      restartTimer.restart()
    }
  }

  Timer {
    id: restartTimer
    repeat: false
    onTriggered: root.startHelper()
  }

  // A helper that stays up for a minute resets the restart backoff.
  Timer {
    interval: 60000
    running: root.helperReady
    onTriggered: root.restartAttempt = 0
  }

  function startHelper() {
    if (helper.running) return
    stopping = false
    helper.running = true
  }

  Component.onCompleted: startHelper()
  Component.onDestruction: {
    stopping = true
    helper.running = false
  }

  onMaxStoredChanged: if (helperReady) request("settings", { settings: { maxStoredMessages: maxStored } })
  // Link line on desktop notifications, "Open %1" with the host (follows the language).
  readonly property string linkLabel: translations.t("item.openLink", "Open %1")
  onLinkLabelChanged: if (helperReady) request("settings", { settings: { linkLabel: linkLabel } })
  onDesktopNotificationsChanged: if (helperReady) request("settings", { settings: { desktopNotifications: desktopNotifications } })

  function handleLine(line) {
    if (line.length === 0 || line.length > 4 * 1024 * 1024) return
    var msg
    try {
      msg = JSON.parse(line)
    } catch (e) {
      return
    }
    if (!msg || typeof msg !== "object") return

    if (msg.id !== undefined && msg.id !== null && msg.event === undefined) {
      var cb = pending[msg.id]
      if (cb) {
        delete pending[msg.id]
        cb(msg.ok === true, msg.ok === true ? msg.result : String(msg.error || "request failed"))
      }
      return
    }

    switch (msg.event) {
    case "ready":
      helperReady = true
      helperError = ""
      lastWarning = ""
      request("settings", { settings: { maxStoredMessages: maxStored, desktopNotifications: desktopNotifications,
        linkLabel: linkLabel } })
      loadFirstPage()
      break
    case "brokers":
      brokers = Array.isArray(msg.brokers) ? msg.brokers : []
      break
    case "notification":
      if (msg.notification) addLive(Format.toRow(msg.notification))
      break
    case "counts":
      unread = Number(msg.unread) || 0
      total = Number(msg.total) || 0
      if (total === 0) items.clear()
      break
    case "config":
      configProblems = Array.isArray(msg.problems) ? msg.problems.slice(0, 20) : []
      configError = msg.error ? String(msg.error) : ""
      configRevision++
      break
    case "openLink":
      // A desktop notification with a link was clicked. The helper validated
      // the URL; check it again before handing it to the desktop.
      var url = Format.safeLink(msg.url)
      if (url !== "") Qt.openUrlExternally(url)
      else panelRequested()
      break
    case "activate":
      // A desktop notification was clicked: open the panel on the focused screen.
      panelRequested()
      break
    case "fatal":
      helperError = String(msg.error || "MQTT helper failed")
      break
    case "log":
      if (msg.level === "error" || msg.level === "warn") {
        lastWarning = String(msg.message || "").slice(0, 300)
        warningTimer.restart()
      }
      break
    }
  }

  function request(op, params, callback) {
    if (!helper.running) {
      if (callback) callback(false, "helper is not running")
      return
    }
    var id = nextRequestId++
    var payload = Object.assign({}, params || {}, { id: id, op: op })
    if (callback) pending[id] = callback
    helper.write(JSON.stringify(payload) + "\n")
  }

  function failPending(reason) {
    var old = pending
    pending = ({})
    for (var id in old) {
      try { old[id](false, reason) } catch (e) {}
    }
  }

  // ---- notification list ----
  function addLive(row) {
    if (items.count > 0 && items.get(0).seq >= row.seq) return
    items.insert(0, row)
    // Keep the closed list small; an open panel keeps what the user paged in
    // (bounded, so a flood of messages can't grow it forever).
    trimTo(openPanels === 0 ? initialCount : 1000)
  }

  function trimTo(count) {
    while (items.count > count) items.remove(items.count - 1)
  }

  function loadFirstPage() {
    loading = true
    request("page", { limit: initialCount }, function(ok, result) {
      loading = false
      if (!ok) return
      items.clear()
      for (var i = 0; i < result.items.length; i++) items.append(Format.toRow(result.items[i]))
      total = result.total
      unread = result.unread
    })
  }

  function loadMore() {
    if (loading || !hasMore) return
    if (items.count === 0) {
      loadFirstPage()
      return
    }
    loading = true
    var before = items.get(items.count - 1).seq
    request("page", { limit: loadMoreCount, beforeSeq: before }, function(ok, result) {
      loading = false
      if (!ok) return
      var known = {}
      for (var i = 0; i < items.count; i++) known[items.get(i).nid] = true
      for (var j = 0; j < result.items.length; j++) {
        var row = Format.toRow(result.items[j])
        if (!known[row.nid]) items.append(row)
      }
      total = result.total
    })
  }

  function markAllRead() {
    request("markAllRead", {}, function(ok, result) {
      if (!ok) return
      var through = Number(result.readThroughSeq) || 0
      for (var i = 0; i < items.count; i++) {
        if (items.get(i).seq <= through && !items.get(i).read) items.setProperty(i, "read", true)
      }
    })
  }

  function clearAll() {
    request("clear", {}, function(ok) {
      if (!ok) return
      items.clear()
      total = 0
      unread = 0
    })
  }

  function reconnect() {
    request("reconnect", {})
  }

  // Each opening starts from the newest `initialCount` messages.
  function panelOpened() {
    openPanels++
    trimTo(initialCount)
    if (items.count < initialCount && items.count < total) loadFirstPage()
    if (markReadOnOpen && unread > 0) markAllRead()
  }

  function panelClosed() {
    openPanels = Math.max(0, openPanels - 1)
  }

  function openConfig() {
    Quickshell.execDetached(["omarchy-launch-config-editor", configPath])
  }

  function openSettings(section) {
    if (shell) shell.summon(pluginId, JSON.stringify({ section: section || "" }))
  }

  // Widget settings live in this plugin's inline shell.json entry.
  function updateSetting(key, value) {
    if (!shell || typeof shell.updateEntryInline !== "function") return false
    var next = Object.assign({}, settings)
    next[key] = value
    return shell.updateEntryInline(pluginId, next)
  }
}
