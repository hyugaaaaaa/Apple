import AppKit
import ApplicationServices

// Usage:
//   leftctl-minimize <app-path>           → そのアプリのウィンドウを最小化
//   leftctl-minimize --others <app-path>  → そのアプリ以外の全ウィンドウを最小化

guard CommandLine.arguments.count >= 2 else {
  fputs("Usage: leftctl-minimize [--others] <app-path>\n", stderr)
  exit(1)
}

func minimizeWindows(of app: NSRunningApplication) -> (Int, Int) {
  let pid = app.processIdentifier
  let axApp = AXUIElementCreateApplication(pid)
  var windowList: CFTypeRef?
  let r = AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windowList)
  guard r == .success, let windows = windowList as? [AXUIElement] else { return (0, 0) }
  var minimized = 0
  for w in windows {
    let r2 = AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, kCFBooleanTrue)
    if r2 == .success { minimized += 1 }
  }
  return (minimized, windows.count)
}

let othersMode = CommandLine.arguments[1] == "--others"
let appPath = othersMode ? CommandLine.arguments[2] : CommandLine.arguments[1]

let allApps = NSWorkspace.shared.runningApplications

if othersMode {
  // 指定アプリ以外の可視アプリを全て最小化
  let targets = allApps.filter { app in
    guard app.activationPolicy == .regular else { return false }
    guard let url = app.bundleURL else { return false }
    return url.path != appPath && !url.path.hasPrefix(appPath + "/")
  }
  var total = 0
  for app in targets {
    let (m, _) = minimizeWindows(of: app)
    total += m
  }
  print("minimized others: \(total) windows across \(targets.count) apps")
  exit(0)
} else {
  // 指定アプリのウィンドウを最小化
  let targets = allApps.filter { app in
    guard let url = app.bundleURL else { return false }
    return url.path == appPath || url.path.hasPrefix(appPath + "/")
  }
  guard let app = targets.first else {
    fputs("App not running: \(appPath)\n", stderr)
    exit(2)
  }
  let (minimized, total) = minimizeWindows(of: app)
  print("minimized \(minimized)/\(total) windows")
  exit(0)
}
