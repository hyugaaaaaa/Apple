import AppKit
import ApplicationServices

// Usage:
//   leftctl-minimize <app-path>           → そのアプリのウィンドウを最小化（フルスクリーン時はアプリをHide）
//   leftctl-minimize --others <app-path>  → そのアプリ以外を最小化／Hide

guard CommandLine.arguments.count >= 2 else {
  fputs("Usage: leftctl-minimize [--others] <app-path>\n", stderr)
  exit(1)
}

// macOS 10.7+ AX fullscreen attribute (not always exposed as Swift constant).
let kAXFullScreen = "AXFullScreen" as CFString

/// Minimize windows of an app. If any window is fullscreen (or all minimize
/// attempts fail), fall back to NSRunningApplication.hide() — this is the
/// Cmd+H equivalent and removes the app from view even in fullscreen.
@discardableResult
func minimizeOrHide(_ app: NSRunningApplication) -> String {
  let pid = app.processIdentifier
  let axApp = AXUIElementCreateApplication(pid)

  var windowList: CFTypeRef?
  let listResult = AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowList)

  guard listResult == .success,
        let windows = windowList as? [AXUIElement],
        !windows.isEmpty else {
    // AX が見えるウィンドウを返さない場合（フルスクリーン状態を含む）は Hide
    app.hide()
    return "hide(no-windows)"
  }

  // フルスクリーンウィンドウが1つでもあれば、アプリ全体を Hide
  for w in windows {
    var fsValue: CFTypeRef?
    if AXUIElementCopyAttributeValue(w, kAXFullScreen, &fsValue) == .success,
       let isFs = fsValue as? Bool, isFs {
      app.hide()
      return "hide(fullscreen)"
    }
  }

  // 各ウィンドウを最小化
  var minimized = 0
  for w in windows {
    if AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, kCFBooleanTrue) == .success {
      minimized += 1
    }
  }

  // 全部失敗した場合は Hide にフォールバック
  if minimized == 0 {
    app.hide()
    return "hide(minimize-failed)"
  }

  return "minimized \(minimized)/\(windows.count)"
}

let othersMode = CommandLine.arguments[1] == "--others"
let appPath = othersMode ? CommandLine.arguments[2] : CommandLine.arguments[1]

let allApps = NSWorkspace.shared.runningApplications

if othersMode {
  // 指定アプリ以外の可視アプリを全て最小化／Hide
  let targets = allApps.filter { app in
    guard app.activationPolicy == .regular else { return false }
    guard let url = app.bundleURL else { return false }
    return url.path != appPath && !url.path.hasPrefix(appPath + "/")
  }
  for app in targets {
    _ = minimizeOrHide(app)
  }
  print("processed others: \(targets.count) apps")
  exit(0)
} else {
  // 指定アプリのウィンドウを最小化／Hide
  let targets = allApps.filter { app in
    guard let url = app.bundleURL else { return false }
    return url.path == appPath || url.path.hasPrefix(appPath + "/")
  }
  guard let app = targets.first else {
    fputs("App not running: \(appPath)\n", stderr)
    exit(2)
  }
  let result = minimizeOrHide(app)
  print(result)
  exit(0)
}
