#!/bin/sh
# Repackage dist/deb-root (built by `make deb`) as `codex-opencode-desktop`,
# a package that installs side by side with stock codex-desktop or the
# official app. Drops the updater (it belongs to the stock package and would
# overwrite this custom build). Run from the repository root after `make deb`.
set -eu

DIST=dist
SRC="$DIST/deb-root"
ROOT="$DIST/oc-root"
NAME=codex-opencode-desktop
VERSION=$(sed -n 's/^Version: //p' "$SRC/DEBIAN/control")

rm -rf "$ROOT"
cp -a "$SRC" "$ROOT"
mv "$ROOT/opt/codex-desktop" "$ROOT/opt/$NAME"

rm -f "$ROOT/usr/bin/codex-update-manager" \
      "$ROOT/usr/lib/systemd/user/codex-update-manager.service" \
      "$ROOT/usr/share/polkit-1/actions/"* 2>/dev/null || true

mv "$ROOT/usr/bin/codex-desktop" "$ROOT/usr/bin/$NAME"
sed -i "s|/opt/codex-desktop/|/opt/$NAME/|g" "$ROOT/usr/bin/$NAME"

mv "$ROOT/usr/share/applications/codex-desktop.desktop" \
   "$ROOT/usr/share/applications/$NAME.desktop"
sed -i -e "s|codex-desktop.desktop|$NAME.desktop|g" \
       -e "s|/usr/bin/codex-desktop|/usr/bin/$NAME|g" \
       -e "s|^Icon=codex-desktop|Icon=$NAME|" \
       -e "s|^Name=.*|Name=Codex OpenCode Desktop|" \
       "$ROOT/usr/share/applications/$NAME.desktop"
for f in $(find "$ROOT/usr/share/icons" -name 'codex-desktop.png'); do
  mv "$f" "${f%codex-desktop.png}$NAME.png"
done

if [ -f "$ROOT/etc/apparmor.d/codex-desktop" ]; then
  mv "$ROOT/etc/apparmor.d/codex-desktop" "$ROOT/etc/apparmor.d/$NAME"
  sed -i "s|codex-desktop|$NAME|g" "$ROOT/etc/apparmor.d/$NAME"
fi

cat > "$ROOT/DEBIAN/postinst" <<EOF
#!/bin/sh
set -eu
DESKTOP_ENTRY_DOCTOR="/opt/$NAME/.codex-linux/codex-desktop-entry-doctor.sh"
if [ -f "\$DESKTOP_ENTRY_DOCTOR" ]; then
    . "\$DESKTOP_ENTRY_DOCTOR"
    codex_desktop_repair_system_package_shadow_entries $NAME || true
fi
if command -v aa-enabled >/dev/null 2>&1 &&
   command -v apparmor_parser >/dev/null 2>&1 &&
   aa-enabled --quiet && [ -f "/etc/apparmor.d/$NAME" ]; then
    apparmor_parser -r -W -T "/etc/apparmor.d/$NAME" >/dev/null 2>&1 || true
fi
exit 0
EOF
printf '#!/bin/sh\nexit 0\n' > "$ROOT/DEBIAN/prerm"
printf '#!/bin/sh\nexit 0\n' > "$ROOT/DEBIAN/postrm"
chmod 755 "$ROOT/DEBIAN/postinst" "$ROOT/DEBIAN/prerm" "$ROOT/DEBIAN/postrm"

sed -i -e "s|^Package: codex-desktop|Package: $NAME|" \
       -e "s|^Description: .*|Description: Codex OpenCode Desktop|" \
       "$ROOT/DEBIAN/control"

OUT="$DIST/${NAME}_${VERSION}_amd64.deb"
dpkg-deb --build --root-owner-group "$ROOT" "$OUT"
echo "Built: $OUT"
