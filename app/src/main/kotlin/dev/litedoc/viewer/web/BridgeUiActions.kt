package dev.litedoc.viewer.web

import org.json.JSONObject

/**
 * UI-side actions the trusted page can ask for. Implemented by the Activity,
 * because they need dialogs, pickers and system panels. Data operations stay in
 * the ViewModel.
 */
interface BridgeUiActions {
    fun onRequestFolderGrant()
    fun onExportRequest(kind: String, options: JSONObject)
    fun onPreferenceChanged(key: String, value: String)
    fun onShowToc()
    fun onShowNotice(message: String)
    fun onSwitchDocument(delta: Int)
    fun onReloadCurrent()
    fun currentDescriptor(): JSONObject
}
