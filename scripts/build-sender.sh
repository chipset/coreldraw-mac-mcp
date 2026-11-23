#!/bin/sh
set -eu

task_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
task_output=${1:-"$task_root/dist/Graphtec Sender.app"}
if [ "$#" -gt 1 ]; then
    printf 'Usage: %s [output-app-path]\n' "$0" >&2
    exit 2
fi
case "$task_output" in
    *.app) ;;
    *) printf 'Output must end in .app\n' >&2; exit 2 ;;
esac
if [ -e "$task_output" ] && [ ! -f "$task_output/Contents/Info.plist" ]; then
    printf 'Refusing to replace a path that is not an app bundle: %s\n' "$task_output" >&2
    exit 2
fi
if [ -e "$task_output/Contents/Info.plist" ]; then
    task_existing_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$task_output/Contents/Info.plist" 2>/dev/null || true)
    if [ "$task_existing_id" != 'net.mcquitty.GraphtecSender' ]; then
        printf 'Refusing to replace an unrelated app bundle: %s\n' "$task_output" >&2
        exit 2
    fi
fi

task_node=$(command -v node || true)
if [ -z "$task_node" ] || [ ! -x "$task_node" ]; then
    printf 'Install Node 22 or newer before building Graphtec Sender.\n' >&2
    exit 1
fi
"$task_node" --input-type=module -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Node 22 or newer is required."); process.exit(1); }'
for task_required in graphtec/cli.mjs graphtec/job.mjs graphtec/corel.mjs graphtec/transport.mjs; do
    if [ ! -f "$task_root/$task_required" ]; then
        printf 'Missing runtime file: %s\n' "$task_required" >&2
        exit 1
    fi
done

task_scratch=$(mktemp -d "${TMPDIR:-/tmp}/graphtec-sender-build.XXXXXX")
trap 'rm -rf "$task_scratch"' EXIT HUP INT TERM
swift build --package-path "$task_root/sender" --scratch-path "$task_scratch/sender" -c release
task_bin=$(swift build --package-path "$task_root/sender" --scratch-path "$task_scratch/sender" -c release --show-bin-path)
if [ ! -x "$task_root/native/coreldraw-bridge" ]; then
    swift build --package-path "$task_root/native" --scratch-path "$task_scratch/native" -c release
    task_native_bin=$(swift build --package-path "$task_root/native" --scratch-path "$task_scratch/native" -c release --show-bin-path)
    cp "$task_native_bin/coreldraw-bridge" "$task_root/native/coreldraw-bridge"
    chmod 755 "$task_root/native/coreldraw-bridge"
fi

task_bundle="$task_scratch/Graphtec Sender.app"
mkdir -p "$task_bundle/Contents/MacOS" "$task_bundle/Contents/Resources/runtime/graphtec" "$task_bundle/Contents/Resources/runtime/src" "$task_bundle/Contents/Resources/runtime/native"
cp "$task_bin/GraphtecSender" "$task_bundle/Contents/MacOS/GraphtecSender"
# Explicit code-only allowlist. Do not bundle repository history, documents,
# cached jobs, build products, user data, credentials or a Node binary.
for task_module in "$task_root/graphtec/"*.mjs; do cp "$task_module" "$task_bundle/Contents/Resources/runtime/graphtec/"; done
for task_module in "$task_root/src/"*.mjs; do cp "$task_module" "$task_bundle/Contents/Resources/runtime/src/"; done
cp "$task_root/native/coreldraw-bridge" "$task_bundle/Contents/Resources/runtime/native/coreldraw-bridge"
chmod 755 "$task_bundle/Contents/MacOS/GraphtecSender" "$task_bundle/Contents/Resources/runtime/native/coreldraw-bridge"

task_plist="$task_bundle/Contents/Info.plist"
/usr/bin/plutil -create xml1 "$task_plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string net.mcquitty.GraphtecSender' "$task_plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleName string Graphtec Sender' "$task_plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleDisplayName string Graphtec Sender' "$task_plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleExecutable string GraphtecSender' "$task_plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundlePackageType string APPL' "$task_plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleShortVersionString string 0.4.0' "$task_plist"
/usr/libexec/PlistBuddy -c 'Add :CFBundleVersion string 4' "$task_plist"
/usr/libexec/PlistBuddy -c 'Add :LSMinimumSystemVersion string 13.0' "$task_plist"
/usr/libexec/PlistBuddy -c 'Add :LSApplicationCategoryType string public.app-category.graphics-design' "$task_plist"
/usr/libexec/PlistBuddy -c 'Add :NSHighResolutionCapable bool true' "$task_plist"
/usr/libexec/PlistBuddy -c 'Add :NSPrincipalClass string NSApplication' "$task_plist"
/usr/libexec/PlistBuddy -c 'Add :NSAppleEventsUsageDescription string Prepare a new print-and-cut page in CorelDRAW.' "$task_plist"
/usr/libexec/PlistBuddy -c 'Add :GraphtecNodePath string placeholder' "$task_plist"
/usr/bin/plutil -replace GraphtecNodePath -string "$task_node" "$task_plist"
/usr/bin/plutil -lint "$task_plist"
/usr/bin/codesign --force --sign - "$task_bundle/Contents/Resources/runtime/native/coreldraw-bridge"
/usr/bin/codesign --force --sign - "$task_bundle"
/usr/bin/codesign --verify --deep --strict "$task_bundle"
mkdir -p "$(dirname -- "$task_output")"
if [ -e "$task_output" ]; then rm -rf "$task_output"; fi
/usr/bin/ditto --norsrc --noextattr "$task_bundle" "$task_output"
# File providers can add Finder metadata when creating an app under Documents.
# Verify the delivered copy as well as the temporary signed bundle.
/usr/bin/xattr -cr "$task_output"
/usr/bin/codesign --verify --deep --strict "$task_output"
printf 'Built %s\nNode runtime: %s (external, not bundled)\n' "$task_output" "$task_node"
