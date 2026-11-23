#!/bin/sh
set -eu
task_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
swift build --package-path "$task_root/native" -c release
task_bin=$(swift build --package-path "$task_root/native" -c release --show-bin-path)
cp "$task_bin/coreldraw-bridge" "$task_root/native/coreldraw-bridge"
chmod 755 "$task_root/native/coreldraw-bridge"
printf 'Built %s\n' "$task_root/native/coreldraw-bridge"
