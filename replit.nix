{pkgs}: {
  deps = [
    pkgs.libgbm
    pkgs.systemd
    pkgs.pango
    pkgs.cairo
    pkgs.libxkbcommon
    pkgs.mesa
    pkgs.libdrm
    pkgs.expat
    pkgs.xorg.libXrandr
    pkgs.xorg.libXfixes
    pkgs.xorg.libXext
    pkgs.xorg.libXdamage
    pkgs.xorg.libXcomposite
    pkgs.cups
    pkgs.alsa-lib
    pkgs.glib
    pkgs.dbus
    pkgs.xorg.libxcb
    pkgs.xorg.libX11
    pkgs.at-spi2-atk
    pkgs.atk
    pkgs.nspr
    pkgs.nss
    pkgs.chromium
  ];
}
