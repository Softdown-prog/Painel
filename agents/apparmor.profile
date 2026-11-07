# Nested rootless sandbox for this application only. Docker still drops ALL
# capabilities; the process stays UID 61110, with read-only root filesystem.
# Namespace-local mounts are needed by Codex bubblewrap; host mounts are not
# granted by this profile or by the container's capability set.
#include <tunables/global>
profile panel-codex flags=(attach_disconnected,mediate_deleted) {
  network,
  capability,
  signal,
  userns,
  mount,
  umount,
  pivot_root,
  / r,
  /** rix,
  /tmp/ rw,
  /tmp/** rwk,
  # Temporary root assembled by bubblewrap in its private mount namespace.
  # There is no writable /newroot in the container's read-only outer root.
  /newroot/ rw,
  /newroot/** rwk,
  /home/node/.codex/ rw,
  /home/node/.codex/** rwk,
  /workspace/ rw,
  /workspace/** rwk,
  /state/ rw,
  /state/** rwk,
  /dev/null rw,
  /dev/zero rw,
  /dev/random r,
  /dev/urandom r,
  /dev/tty rw,
  /proc/[0-9]*/uid_map rw,
  /proc/[0-9]*/gid_map rw,
  /proc/[0-9]*/setgroups rw,
  deny ptrace,
  deny /proc/sys/** wklx,
  deny /proc/sysrq-trigger rwklx,
  deny /proc/kcore rwklx,
  deny /sys/** wklx,
}
