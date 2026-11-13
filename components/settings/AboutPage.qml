import QtQuick
import qs.Commons
import qs.Ui
import ".."

// Version, helper status, file locations.
SettingsPage {
  id: page

  readonly property var s: app.strings
  property var stats: null

  title: s.t("settings.about.title")
  subtitle: s.t("settings.about.subtitle")

  Component.onCompleted: app.service.request("stats", {}, function(ok, r) { if (ok) page.stats = r })

  Repeater {
    model: [
      { label: page.s.t("settings.about.version"), value: page.app.manifest ? String(page.app.manifest.version) : "" },
      { label: page.s.t("settings.about.helper"), value: page.app.service.helperReady ? page.s.t("settings.about.running") : (page.app.service.helperError || page.s.t("settings.about.starting")) },
      { label: page.s.t("settings.about.sandbox"), value: !page.stats ? "…" : (page.stats.sandbox === "not started" ? page.s.t("settings.about.sandboxLazy") : page.s.t("settings.about.sandbox_" + page.stats.sandbox)) },
      { label: page.s.t("settings.about.config"), value: page.app.cfg ? page.app.cfg.path : "" },
      { label: page.s.t("settings.about.state"), value: page.stats ? String(page.stats.statePath) : "…" },
      { label: page.s.t("settings.about.logs"), value: page.stats ? String(page.stats.statePath) + "/logs/helper.log" : "…" }
    ]
    delegate: FieldRow {
      required property var modelData
      app: page.app
      label: modelData.label
      PlainText {
        width: parent.width
        topPadding: Style.space(6)
        text: modelData.value
        color: page.app.foreground
        font.family: page.app.fontFamily
        font.pixelSize: Style.font.body
        wrapMode: Text.WrapAnywhere
      }
    }
  }

  PlainText {
    width: parent.width
    text: page.s.t("settings.about.parserNote")
    color: page.app.dim
    font.family: page.app.fontFamily
    font.pixelSize: Style.font.caption
    wrapMode: Text.Wrap
  }

  Button {

    focusable: true
    text: page.s.t("settings.about.openConfig")
    foreground: page.app.foreground
    accent: page.app.accent
    fontFamily: page.app.fontFamily
    onClicked: page.app.service.openConfig()
  }
}
