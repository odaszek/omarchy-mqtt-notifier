import QtQuick
import QtQuick.Controls
import QtQuick.Window
import Quickshell
import Quickshell.Hyprland
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "components"
import "components/settings"

// Settings window ("panel" entry point). The shell loads this while the panel
// is open (summon) and destroys it on hide. It edits config.json through the
// helper (getConfig / saveConfig), so hand edits and the window stay in sync.
Item {
  id: root

  // Set by the shell's panel loader.
  property var shell: null
  property var manifest: null
  property var service: null

  readonly property string pluginId: "odach.mqtt-notifier"
  property bool closingFromHost: false

  // ---- shared state for the pages ----
  property var cfg: null          // getConfig result
  property string loadError: ""
  property bool busy: false
  property string section: "brokers"
  // True while a page has an editor open; config reloads wait until it closes.
  property bool editing: false
  // True while an open editor holds changes that are not saved yet.
  property bool dirty: false
  property bool reloadPending: false
  // Deep link from the summon payload: {"edit": "<brokerId>" | "<brokerId>/<subId>" | "new"}.
  // Consumed by the page once the config is loaded.
  property string pendingEdit: ""
  property bool pageReset: false

  readonly property color background: Commons.Color.popups.background
  readonly property color foreground: Commons.Color.popups.text
  readonly property color accent: Commons.Color.accent
  readonly property color urgent: Commons.Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property color subtle: Util.alpha(foreground, 0.06)
  readonly property color line: Util.alpha(foreground, 0.12)
  readonly property string fontFamily: Style.font.family

  readonly property var sections: [
    { key: "general", label: strings.t("settings.nav.general") },
    { key: "brokers", label: strings.t("settings.nav.brokers") },
    { key: "subscriptions", label: strings.t("settings.nav.subscriptions") },
    { key: "storage", label: strings.t("settings.nav.storage") },
    { key: "about", label: strings.t("settings.nav.about") }
  ]

  Commons.Translations {
    id: translations
    directory: Qt.resolvedUrl("i18n")
  }
  readonly property alias strings: translations

  // ---- lifecycle (called by the shell) ----
  function open(payloadJson) {
    var payload = {}
    try { payload = JSON.parse(payloadJson || "{}") || {} } catch (e) {}
    if (typeof payload.section === "string" && payload.section !== "") {
      for (var i = 0; i < sections.length; i++) if (sections[i].key === payload.section) section = payload.section
    }
    pendingEdit = typeof payload.edit === "string" ? payload.edit : ""
    // A deep link rebuilds the page so it can pick up the edit target.
    if (pendingEdit !== "") {
      pageReset = true
      Qt.callLater(function() { root.pageReset = false })
    }
    closingFromHost = false
    window.visible = true
    reload()
  }

  function close() {
    closingFromHost = true
    window.visible = false
    closingFromHost = false
  }

  function requestClose() {
    if (shell && typeof shell.hide === "function") shell.hide(pluginId)
    else window.visible = false
  }

  // ---- data ----
  function reload() {
    if (!service) {
      loadError = strings.t("settings.serviceMissing")
      return
    }
    busy = true
    service.request("getConfig", {}, function(ok, result) {
      busy = false
      if (!ok) {
        loadError = String(result)
        return
      }
      loadError = ""
      cfg = result
    })
  }

  Connections {
    target: root.service
    function onConfigRevisionChanged() {
      if (!window.visible) return
      if (root.editing) root.reloadPending = true
      else root.reload()
    }
  }

  onEditingChanged: if (!editing && reloadPending) {
    reloadPending = false
    reload()
  }

  // Returns and clears the pending deep link.
  function takeEdit() {
    var edit = pendingEdit
    pendingEdit = ""
    return edit
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value))
  }

  function brokers() {
    return cfg && Array.isArray(cfg.brokers) ? clone(cfg.brokers) : []
  }

  // Save a full broker list. done(ok, errors[{path,message}])
  function saveBrokers(list, parserFiles, done) {
    if (!service) {
      done(false, [{ path: "", message: strings.t("settings.serviceMissing") }])
      return
    }
    busy = true
    service.request("saveConfig", { brokers: list, parserFiles: parserFiles || {} }, function(ok, result) {
      busy = false
      if (!ok) {
        done(false, [{ path: "", message: String(result) }])
        return
      }
      if (!result.saved) {
        done(false, result.errors || [])
        return
      }
      done(true, [])
      reload()
    })
  }

  // Lowercase slug that is unique among `taken` ids.
  function uniqueId(base, taken) {
    var slug = String(base || "").toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48)
    if (!/^[a-z0-9]/.test(slug)) slug = "item" + (slug ? "-" + slug : "")
    var id = slug
    var n = 2
    while (taken.indexOf(id) !== -1) id = slug + "-" + n++
    return id
  }

  function brokerStatus(id) {
    var list = service ? service.brokers : []
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]
    return null
  }

  // Semantic status colours (spec: green / yellow / red / grey).
  function statusColor(state) {
    if (state === "connected") return "#5fb36b"
    if (state === "connecting") return "#d9b44a"
    if (state === "disconnected" || state === "error") return "#d9534f"
    return Commons.Color.muted
  }

  function statusLabel(status, enabled) {
    if (!enabled) return strings.t("settings.state.disabled")
    if (!status) return strings.t("settings.state.unsaved")
    return strings.t("settings.state." + status.state)
  }

  // Show helper validation errors as readable lines.
  function errorLines(errors) {
    var out = []
    for (var i = 0; i < errors.length; i++) out.push((errors[i].path ? errors[i].path + ": " : "") + errors[i].message)
    return out.join("\n")
  }

  // Hyprland tiles new toplevels, and a title-based window rule does not
  // match this window at map time. Float, size and centre it ourselves once
  // it is mapped (skipped when a user rule already floats it).
  Process {
    id: floatProc
    command: ["bash", "-c",
      "for i in $(seq 1 30); do w=$(hyprctl clients -j | jq -r '.[] | select(.class==\"org.quickshell\" and (.title|startswith(\"MQTT Notifier\"))) | \"\\(.address) \\(.floating)\"' | head -1); "
      + "[ -n \"$w\" ] && break; sleep 0.05; done; [ -n \"$w\" ] || exit 0; a=${w%% *}; "
      + "if [ \"${w##* }\" = false ]; then "
      + "hyprctl dispatch \"hl.dsp.window.float({ action = \\\"on\\\", window = \\\"address:$a\\\" })\" >/dev/null; "
      + "hyprctl dispatch \"hl.dsp.window.resize({ x = 940, y = 700, window = \\\"address:$a\\\" })\" >/dev/null; "
      + "hyprctl dispatch \"hl.dsp.window.center({ window = \\\"address:$a\\\" })\" >/dev/null; fi; "
      // Hyprland doesn't focus it by itself; focus it so typing works and
      // clicking elsewhere closes it.
      + "hyprctl dispatch \"hl.dsp.focus({ window = \\\"address:$a\\\" })\" >/dev/null"]
  }

  // ---- window ----
  FloatingWindow {
    id: window
    title: "MQTT Notifier – " + root.strings.t("settings.title")
    color: root.background
    implicitWidth: 940
    implicitHeight: 700
    minimumSize: Qt.size(760, 520)
    visible: false

    onVisibleChanged: {
      if (visible) floatProc.running = true
      if (!visible && !root.closingFromHost && root.shell && typeof root.shell.hide === "function") root.shell.hide(root.pluginId)
    }

    Item {
      id: content
      anchors.fill: parent
      focus: true

      // Esc closes the window from anywhere in it (a window shortcut, so a
      // focused text field or button can't swallow it). An open confirmation
      // dialog is cancelled first. Unsaved editor changes are discarded.
      Shortcut {
        sequence: "Escape"
        context: Qt.WindowShortcut
        onActivated: {
          var page = pageLoader.item
          if (page && typeof page.cancelDialog === "function" && page.cancelDialog()) return
          root.requestClose()
        }
      }

      // A click outside the window closes it, unless an editor has unsaved
      // changes. Focus loss can't be used for this: with Hyprland's
      // follow_mouse, merely moving the pointer off the window moves focus.
      // A Hyprland focus grab keeps focus here while the pointer wanders and
      // reports the first click outside ("cleared"). It is armed whenever the
      // window is focused, so after leaving with unsaved changes, coming back
      // re-arms it.
      readonly property bool windowActive: Window.active
      onWindowActiveChanged: if (windowActive && window.visible) outsideClick.active = true

      HyprlandFocusGrab {
        id: outsideClick
        windows: [window]
        onCleared: if (!root.dirty && window.visible) root.requestClose()
      }

      // ---- sidebar ----
      Rectangle {
        id: sidebar
        anchors.left: parent.left
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        width: Style.space(200)
        color: root.subtle

        Column {
          anchors.fill: parent
          anchors.margins: Style.space(14)
          spacing: Style.space(4)

          PlainText {
            text: "MQTT Notifier"
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.title
            font.bold: true
            bottomPadding: Style.space(12)
          }

          Repeater {
            model: root.sections
            delegate: Button {
              focusable: true
              required property var modelData
              width: parent.width
              text: modelData.label
              leftAlign: true
              selected: root.section === modelData.key
              foreground: root.foreground
              accent: root.accent
              fontFamily: root.fontFamily
              enabled: !root.editing || root.section === modelData.key
              onClicked: root.section = modelData.key
            }
          }
        }
      }

      // ---- page ----
      Item {
        anchors.left: sidebar.right
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.bottom: parent.bottom

        PlainText {
          anchors.centerIn: parent
          visible: root.cfg === null
          text: root.loadError !== "" ? root.loadError : root.strings.t("settings.loading")
          color: root.loadError !== "" ? root.urgent : root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
        }

        Loader {
          id: pageLoader
          anchors.fill: parent
          anchors.margins: Style.space(20)
          active: root.cfg !== null && !root.pageReset
          sourceComponent: {
            switch (root.section) {
            case "general": return generalPage
            case "subscriptions": return subscriptionsPage
            case "storage": return storagePage
            case "about": return aboutPage
            default: return brokersPage
            }
          }
        }
      }
    }
  }

  Component { id: generalPage; GeneralPage { app: root } }
  Component { id: brokersPage; BrokersPage { app: root } }
  Component { id: subscriptionsPage; SubscriptionsPage { app: root } }
  Component { id: storagePage; StoragePage { app: root } }
  Component { id: aboutPage; AboutPage { app: root } }
}
