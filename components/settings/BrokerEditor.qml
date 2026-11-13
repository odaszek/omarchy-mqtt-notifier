import QtQuick
import qs.Commons
import qs.Ui
import ".."

// Add/edit one broker. Saves the whole broker list through the helper, then
// stores a typed password in the keyring (never in config.json).
Column {
  id: root

  required property var app
  required property int index     // -2 = new broker
  readonly property var s: app.strings
  readonly property bool isNew: index === -2
  readonly property var original: isNew ? null : app.cfg.brokers[index]
  readonly property var secretState: !isNew && app.cfg.secrets && app.cfg.secrets[original.id]
    ? app.cfg.secrets[original.id] : ({ password: false, keyPassphrase: false })

  property var errors: []
  property string testResult: ""
  property bool testOk: false
  property bool testing: false
  property bool clearPassword: false

  signal finished()

  spacing: Style.space(12)

  // Field values (strings for text inputs, typed on save).
  property string fName: isNew ? "" : original.name
  property string fHost: isNew ? "" : original.host
  property int fPort: isNew ? 1883 : original.port
  property string fProtocol: isNew ? "mqtt" : original.protocol
  property int fVersion: isNew ? 4 : original.mqttVersion
  property string fClientId: isNew ? "" : original.clientId
  property string fUsername: isNew ? "" : original.username
  property int fKeepAlive: isNew ? 60 : original.keepAlive
  property bool fClean: isNew ? true : original.cleanSession
  property int fConnectTimeout: isNew ? 10 : original.connectTimeout
  property int fReconnect: isNew ? 2 : original.reconnectInterval
  property int fMaxReconnect: isNew ? 60 : original.maxReconnectInterval
  property bool fEnabled: isNew ? true : original.enabled
  property bool fRejectUnauthorized: isNew ? true : original.tls.rejectUnauthorized
  property string fCa: isNew || !original.tls.ca ? "" : original.tls.ca
  property string fCert: isNew || !original.tls.cert ? "" : original.tls.cert
  property string fKey: isNew || !original.tls.key ? "" : original.tls.key

  readonly property var certOptions: {
    var out = [{ value: "", label: s.t("settings.brokers.none") }]
    var files = app.cfg.certs || []
    for (var i = 0; i < files.length; i++) out.push({ value: files[i], label: files[i] })
    return out
  }

  function fieldError(name) {
    for (var i = 0; i < errors.length; i++) {
      var p = String(errors[i].path)
      if (p.slice(p.lastIndexOf(".") + 1) === name) return errors[i].message
    }
    return ""
  }

  function draft() {
    var taken = []
    for (var i = 0; i < app.cfg.brokers.length; i++) if (i !== index) taken.push(app.cfg.brokers[i].id)
    var id = isNew ? app.uniqueId(fName.trim() || fHost.trim() || "broker", taken) : original.id
    return {
      id: id,
      name: fName.trim(),
      host: fHost.trim(),
      port: fPort,
      protocol: fProtocol,
      mqttVersion: fVersion,
      clientId: fClientId.trim(),
      username: fUsername,
      keepAlive: fKeepAlive,
      cleanSession: fClean,
      connectTimeout: fConnectTimeout,
      reconnectInterval: fReconnect,
      maxReconnectInterval: Math.max(fReconnect, fMaxReconnect),
      enabled: fEnabled,
      tls: { rejectUnauthorized: fRejectUnauthorized, ca: fCa || null, cert: fCert || null, key: fKey || null },
      subscriptions: isNew ? [] : app.clone(original.subscriptions)
    }
  }

  function testConnection() {
    testing = true
    testResult = ""
    app.service.request("testConnection", { broker: draft(), password: passwordField.text }, function(ok, result) {
      testing = false
      if (!ok) {
        testOk = false
        testResult = String(result)
        return
      }
      testOk = result.ok
      testResult = result.ok ? s.t("settings.brokers.testOk").arg(result.ms) : String(result.error || s.t("settings.brokers.testFailed"))
    })
  }

  function save() {
    var broker = draft()
    var brokers = app.brokers()
    if (isNew) brokers.push(broker)
    else brokers[index] = broker
    errors = []
    app.saveBrokers(brokers, {}, function(ok, errs) {
      if (!ok) {
        // Paths refer to the full list; keep only this broker's errors (and global ones).
        var mine = []
        var prefix = "brokers[" + (isNew ? brokers.length - 1 : index) + "]"
        for (var i = 0; i < errs.length; i++) {
          if (!errs[i].path || String(errs[i].path).indexOf(prefix) === 0) mine.push(errs[i])
        }
        errors = mine.length > 0 ? mine : errs
        return
      }
      storeSecrets(broker.id)
    })
  }

  // Secrets go to the keyring after the broker exists in config.json.
  function storeSecrets(brokerId) {
    var steps = []
    if (passwordField.text !== "") steps.push({ op: "setSecret", params: { brokerId: brokerId, field: "password", value: passwordField.text } })
    else if (clearPassword) steps.push({ op: "clearSecret", params: { brokerId: brokerId, field: "password" } })
    if (fKey !== "" && passphraseField.text !== "") {
      steps.push({ op: "setSecret", params: { brokerId: brokerId, field: "keyPassphrase", value: passphraseField.text } })
    }
    function next(i) {
      if (i >= steps.length) {
        if (steps.length > 0) app.service.reconnect()
        root.finished()
        return
      }
      app.service.request(steps[i].op, steps[i].params, function(ok, result) {
        if (!ok) {
          errors = [{ path: "", message: s.t("settings.brokers.secretFailed").arg(String(result)) }]
          return
        }
        next(i + 1)
      })
    }
    next(0)
  }

  // ---- connection ----
  PanelSectionHeader {
    width: parent.width
    text: root.s.t("settings.brokers.connection")
    foreground: root.app.foreground
    fontFamily: root.app.fontFamily
  }

  FieldRow {
    app: root.app
    label: root.s.t("settings.brokers.name")
    error: root.fieldError("name")
    TextField {
      width: parent.width
      text: root.fName
      placeholderText: "HomeMQTT"
      foreground: root.app.foreground
      accent: root.app.accent
      font.family: root.app.fontFamily
      onTextEdited: root.fName = text
    }
  }

  FieldRow {
    app: root.app
    label: root.s.t("settings.brokers.host")
    error: root.fieldError("host")
    TextField {
      width: parent.width
      text: root.fHost
      placeholderText: "192.168.1.10"
      foreground: root.app.foreground
      accent: root.app.accent
      font.family: root.app.fontFamily
      onTextEdited: root.fHost = text
    }
  }

  FieldRow {
    app: root.app
    label: root.s.t("settings.brokers.port")
    error: root.fieldError("port")
    // A plain field: a spin box would format the port with a thousands separator.
    TextField {
      width: Style.space(120)
      text: String(root.fPort)
      inputMethodHints: Qt.ImhDigitsOnly
      validator: IntValidator { bottom: 1; top: 65535 }
      foreground: root.app.foreground
      accent: root.app.accent
      font.family: root.app.fontFamily
      onTextEdited: if (acceptableInput) root.fPort = Number(text)
    }
  }

  FieldRow {
    app: root.app
    label: root.s.t("settings.brokers.protocol")
    Dropdown {
      width: Math.min(parent.width, Style.space(260))
      showLabel: false
      options: [{ value: "mqtt", label: root.s.t("settings.brokers.tcp") }, { value: "mqtts", label: root.s.t("settings.brokers.tls") }]
      value: root.fProtocol
      fontFamily: root.app.fontFamily
      onChanged: function(v) {
        // Follow the protocol's standard port unless a custom one was set.
        if (v === "mqtts" && root.fPort === 1883) root.fPort = 8883
        else if (v === "mqtt" && root.fPort === 8883) root.fPort = 1883
        root.fProtocol = v
      }
    }
  }

  FieldRow {
    app: root.app
    label: root.s.t("settings.brokers.version")
    Dropdown {
      width: Math.min(parent.width, Style.space(260))
      showLabel: false
      options: [{ value: "4", label: "MQTT 3.1.1" }, { value: "5", label: "MQTT 5.0" }]
      value: String(root.fVersion)
      fontFamily: root.app.fontFamily
      onChanged: function(v) { root.fVersion = Number(v) }
    }
  }

  FieldRow {
    app: root.app
    label: root.s.t("settings.brokers.clientId")
    hint: root.s.t("settings.brokers.clientIdHint")
    TextField {
      width: parent.width
      text: root.fClientId
      placeholderText: "omarchy-mqtt-…"
      foreground: root.app.foreground
      accent: root.app.accent
      font.family: root.app.fontFamily
      onTextEdited: root.fClientId = text
    }
  }

  Toggle {
    width: parent.width
    label: root.s.t("settings.brokers.enabled")
    checked: root.fEnabled
    foreground: root.app.foreground
    accent: root.app.accent
    fontFamily: root.app.fontFamily
    onClicked: root.fEnabled = !root.fEnabled
  }

  // ---- authentication ----
  PanelSectionHeader {
    width: parent.width
    text: root.s.t("settings.brokers.auth")
    foreground: root.app.foreground
    fontFamily: root.app.fontFamily
  }

  FieldRow {
    app: root.app
    label: root.s.t("settings.brokers.username")
    TextField {
      width: parent.width
      text: root.fUsername
      foreground: root.app.foreground
      accent: root.app.accent
      font.family: root.app.fontFamily
      onTextEdited: root.fUsername = text
    }
  }

  FieldRow {
    app: root.app
    label: root.s.t("settings.brokers.password")
    hint: root.secretState.password && !root.clearPassword ? root.s.t("settings.brokers.passwordStored") : root.s.t("settings.brokers.passwordHint")
    TextField {
      id: passwordField
      width: parent.width
      password: true
      echoMode: TextInput.Password
      placeholderText: root.secretState.password && !root.clearPassword ? "••••••••" : ""
      foreground: root.app.foreground
      accent: root.app.accent
      font.family: root.app.fontFamily
    }
  }

  Button {

    focusable: true
    visible: root.secretState.password && !root.clearPassword
    text: root.s.t("settings.brokers.removePassword")
    foreground: root.app.foreground
    accent: root.app.accent
    fontFamily: root.app.fontFamily
    onClicked: root.clearPassword = true
  }

  // ---- TLS ----
  PanelSectionHeader {
    visible: root.fProtocol === "mqtts"
    width: parent.width
    text: root.s.t("settings.brokers.tlsSection")
    foreground: root.app.foreground
    fontFamily: root.app.fontFamily
  }

  Toggle {
    visible: root.fProtocol === "mqtts"
    width: parent.width
    label: root.s.t("settings.brokers.verify")
    description: root.s.t("settings.brokers.verifyHint")
    checked: root.fRejectUnauthorized
    foreground: root.app.foreground
    accent: root.app.accent
    fontFamily: root.app.fontFamily
    onClicked: root.fRejectUnauthorized = !root.fRejectUnauthorized
  }

  PlainText {
    visible: root.fProtocol === "mqtts"
    width: parent.width
    text: root.s.t("settings.brokers.certsHint").arg(root.app.cfg.path.replace(/config\.json$/, "certs/"))
    color: root.app.dim
    font.family: root.app.fontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.Wrap
  }

  Repeater {
    model: root.fProtocol === "mqtts" ? [
      { key: "ca", label: root.s.t("settings.brokers.ca") },
      { key: "cert", label: root.s.t("settings.brokers.cert") },
      { key: "key", label: root.s.t("settings.brokers.key") }
    ] : []
    delegate: FieldRow {
      required property var modelData
      app: root.app
      label: modelData.label
      Dropdown {
        width: Math.min(parent.width, Style.space(320))
        showLabel: false
        options: root.certOptions
        value: modelData.key === "ca" ? root.fCa : (modelData.key === "cert" ? root.fCert : root.fKey)
        fontFamily: root.app.fontFamily
        onChanged: function(v) {
          if (modelData.key === "ca") root.fCa = v
          else if (modelData.key === "cert") root.fCert = v
          else root.fKey = v
        }
      }
    }
  }

  FieldRow {
    visible: root.fProtocol === "mqtts" && root.fKey !== ""
    app: root.app
    label: root.s.t("settings.brokers.passphrase")
    hint: root.secretState.keyPassphrase ? root.s.t("settings.brokers.passwordStored") : root.s.t("settings.brokers.passphraseHint")
    TextField {
      id: passphraseField
      width: parent.width
      password: true
      echoMode: TextInput.Password
      foreground: root.app.foreground
      accent: root.app.accent
      font.family: root.app.fontFamily
    }
  }

  // ---- session ----
  PanelSectionHeader {
    width: parent.width
    text: root.s.t("settings.brokers.session")
    foreground: root.app.foreground
    fontFamily: root.app.fontFamily
  }

  FieldRow {
    app: root.app
    label: root.s.t("settings.brokers.keepAlive")
    NumberField {
      from: 0
      to: 65535
      value: root.fKeepAlive
      foreground: root.app.foreground
      accent: root.app.accent
      fontFamily: root.app.fontFamily
      onModified: function(v) { root.fKeepAlive = v }
    }
  }

  FieldRow {
    app: root.app
    label: root.s.t("settings.brokers.connectTimeout")
    NumberField {
      from: 1
      to: 300
      value: root.fConnectTimeout
      foreground: root.app.foreground
      accent: root.app.accent
      fontFamily: root.app.fontFamily
      onModified: function(v) { root.fConnectTimeout = v }
    }
  }

  FieldRow {
    app: root.app
    label: root.s.t("settings.brokers.reconnect")
    hint: root.s.t("settings.brokers.reconnectHint")
    Row {
      spacing: Style.space(12)
      NumberField {
        anchors.verticalCenter: parent.verticalCenter
        from: 1
        to: 3600
        value: root.fReconnect
        foreground: root.app.foreground
        accent: root.app.accent
        fontFamily: root.app.fontFamily
        onModified: function(v) { root.fReconnect = v }
      }
      NumberField {
        anchors.verticalCenter: parent.verticalCenter
        label: root.s.t("settings.brokers.max")
        from: 1
        to: 3600
        value: root.fMaxReconnect
        foreground: root.app.foreground
        accent: root.app.accent
        fontFamily: root.app.fontFamily
        onModified: function(v) { root.fMaxReconnect = v }
      }
    }
  }

  Toggle {
    width: parent.width
    label: root.s.t("settings.brokers.clean")
    description: root.s.t("settings.brokers.cleanHint")
    checked: root.fClean
    foreground: root.app.foreground
    accent: root.app.accent
    fontFamily: root.app.fontFamily
    onClicked: root.fClean = !root.fClean
  }

  // ---- results + actions ----
  MessageBox {
    app: root.app
    text: root.testing ? root.s.t("settings.brokers.testing") : root.testResult
    error: !root.testing && !root.testOk
  }

  MessageBox {
    app: root.app
    error: true
    text: root.app.errorLines(root.errors)
  }

  Row {
    spacing: Style.space(8)

    Button {

      focusable: true
      text: root.s.t("settings.save")
      foreground: root.app.foreground
      accent: root.app.accent
      fontFamily: root.app.fontFamily
      bordered: true
      enabled: !root.app.busy
      onClicked: root.save()
    }

    Button {

      focusable: true
      text: root.s.t("settings.brokers.test")
      foreground: root.app.foreground
      accent: root.app.accent
      fontFamily: root.app.fontFamily
      enabled: !root.testing
      onClicked: root.testConnection()
    }

    Button {

      focusable: true
      text: root.s.t("settings.cancel")
      foreground: root.app.foreground
      accent: root.app.accent
      fontFamily: root.app.fontFamily
      onClicked: root.finished()
    }
  }
}
