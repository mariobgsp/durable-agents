import assert from "node:assert/strict";

/**
 * Pure detection checks: no daemon, no root. The Fedora path is asserted here because this development host
 * is Arch; the command table, the sudoers content and the os-release parser are all deterministic.
 */
export default {
  name: "sudo-detect",
  async run() {
    const platform = await import(
      new URL("../../../packages/core/src/platform.ts", import.meta.url).href
    );
    const tools = {
      dnf: "/usr/bin/dnf",
      aptGet: "/usr/bin/apt-get",
      pacman: "/usr/bin/pacman",
      paccache: "/usr/bin/paccache",
      zypper: "/usr/bin/zypper",
      apk: "/sbin/apk",
      journalctl: "/usr/bin/journalctl",
      systemdTmpfiles: "/usr/bin/systemd-tmpfiles",
      sync: "/usr/bin/sync",
      sysctl: "/usr/bin/sysctl",
      truePath: "/usr/bin/true",
    };

    const fedoraText = [
      "NAME=\"Fedora Linux\"",
      "VERSION=\"41 (Workstation Edition)\"",
      "ID=fedora",
      "VERSION_ID=41",
      "PRETTY_NAME=\"Fedora Linux 41 (Workstation Edition)\"",
    ].join("\n");
    const fedora = platform.parseOsRelease(fedoraText);
    assert.equal(fedora.family, "fedora");
    assert.equal(fedora.id, "fedora");
    assert.equal(fedora.versionId, "41");
    assert.equal(fedora.prettyName, "Fedora Linux 41 (Workstation Edition)");

    const rhel = platform.parseOsRelease("ID=\"rhel\"\nID_LIKE=\"fedora\"\nVERSION_ID=\"9.4\"\n");
    assert.equal(rhel.family, "fedora");
    const ubuntu = platform.parseOsRelease("ID=ubuntu\nID_LIKE=debian\n");
    assert.equal(ubuntu.family, "debian");
    const omarchy = platform.parseOsRelease("ID=omarchy\nID_LIKE=arch\n");
    assert.equal(omarchy.family, "arch");
    const suse = platform.parseOsRelease("ID=\"opensuse-tumbleweed\"\nID_LIKE=\"opensuse suse\"\n");
    assert.equal(suse.family, "suse");
    const alpine = platform.parseOsRelease("ID=alpine\n");
    assert.equal(alpine.family, "alpine");
    const unknown = platform.parseOsRelease("ID=void\n");
    assert.equal(unknown.family, "unknown");

    const dnf = platform.commandsFor("dnf", tools, { systemd: true });
    assert.deepEqual(dnf.commands.update, [["/usr/bin/dnf", "-y", "upgrade", "--refresh"]]);
    assert.deepEqual(dnf.commands.cleanup, [
      ["/usr/bin/dnf", "clean", "all"],
      ["/usr/bin/journalctl", "--vacuum-size=200M"],
      ["/usr/bin/systemd-tmpfiles", "--clean"],
    ]);
    assert.deepEqual(dnf.commands.memory, [
      ["/usr/bin/sync"],
      ["/usr/bin/sysctl", "-w", "vm.drop_caches=3"],
    ]);

    const fedoraRules = platform.sudoersContent("alice", dnf.commands, "fixed");
    assert.ok(fedoraRules.includes("alice ALL=(root) NOPASSWD: /usr/bin/dnf -y upgrade --refresh"));
    assert.ok(fedoraRules.includes("alice ALL=(root) NOPASSWD: /usr/bin/dnf clean all"));
    assert.ok(!fedoraRules.includes("pacman"));
    const rootRules = platform.sudoersContent("alice", dnf.commands, "root");
    assert.ok(rootRules.includes("alice ALL=(root) NOPASSWD: ALL"));

    const apt = platform.commandsFor("apt-get", tools, { systemd: true });
    assert.deepEqual(apt.commands.update, [
      ["/usr/bin/apt-get", "update"],
      ["/usr/bin/apt-get", "-y", "full-upgrade"],
    ]);
    assert.deepEqual(apt.commands.cleanup[0], ["/usr/bin/apt-get", "clean"]);

    const pacman = platform.commandsFor("pacman", tools, { systemd: true });
    assert.deepEqual(pacman.commands.update, [["/usr/bin/pacman", "-Syu", "--noconfirm"]]);
    assert.deepEqual(pacman.commands.cleanup[0], ["/usr/bin/paccache", "-rk2"]);
    const pacmanWithoutPaccache = platform.commandsFor(
      "pacman",
      { ...tools, paccache: undefined },
      { systemd: true },
    );
    assert.deepEqual(pacmanWithoutPaccache.commands.cleanup[0], [
      "/usr/bin/pacman",
      "-Sc",
      "--noconfirm",
    ]);

    const zypper = platform.commandsFor("zypper", tools, { systemd: true });
    assert.deepEqual(zypper.commands.update, [["/usr/bin/zypper", "--non-interactive", "update"]]);
    const apk = platform.commandsFor("apk", tools, { systemd: false });
    assert.deepEqual(apk.commands.update, [["/sbin/apk", "upgrade", "--no-interactive"]]);
    assert.ok(!apk.commands.cleanup.some((command) => command[0].includes("journalctl")));

    const none = platform.commandsFor("unknown", tools, { systemd: true });
    assert.equal(none.commands.update.length, 0);
    assert.ok(none.commands.cleanup.length > 0);
    assert.ok(none.unsupported.some((note) => note.includes("No supported package manager")));

    const atomic = platform.commandsFor("dnf", tools, { systemd: true, atomic: true });
    assert.equal(atomic.commands.update.length, 0);
    assert.ok(!atomic.commands.cleanup.some((command) => command.includes("clean")));
    assert.ok(atomic.unsupported.some((note) => note.includes("rpm-ostree")));

    assert.equal(platform.cachePathsFor("dnf").includes("/var/cache/dnf"), true);
    assert.equal(platform.cachePathsFor("pacman")[0], "/var/cache/pacman/pkg");
    assert.throws(() => platform.sudoersContent("bad user", dnf.commands, "fixed"));
  },
};
