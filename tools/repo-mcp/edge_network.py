#!/usr/bin/env python3
"""Authorize an optional private network joining only the preexisting MCP and Tunnel.
Requires root for mutating operations; does not create public routes or touch host firewall.
"""
from __future__ import annotations
import argparse
import json
import os
import subprocess
import sys

NETWORK = "vps_code_mcp_edge"
MCP = "vps-code-mcp"
TUNNEL = "softload-panel-tunnel"
ALIAS = "code-mcp-bridge"
ORIGIN = "http://code-mcp-bridge:8789"
OWNER = "com.softdown.code-mcp.edge"


def ensure(ok, description):
    if not ok:
        raise RuntimeError(description)


class Docker:
    def run(self, *args, missing_ok=False):
        proc = subprocess.run(
            ["docker", *args], capture_output=True, text=True, timeout=25, check=False
        )
        if proc.returncode:
            if missing_ok and proc.returncode == 1 and "No such network" in proc.stderr:
                return None
            raise RuntimeError("Docker command failed: " + args[0] + " " + args[1])
        return proc.stdout.strip()

    def container(self, name):
        return json.loads(self.run("inspect", "--type=container", name))[0]

    def network(self):
        data = self.run("network", "inspect", NETWORK, missing_ok=True)
        return json.loads(data)[0] if data else None


def check_container(mcp, tunnel):
    ensure(mcp.get("Name") == "/" + MCP and mcp.get("State", {}).get("Running"),
           "MCP container not running or identity mismatch")
    ensure(mcp.get("State", {}).get("Health", {}).get("Status") == "healthy",
           "MCP container not healthy")
    ensure(mcp.get("Config", {}).get("Labels", {}).get("com.softdown.code-mcp.managed") == "true",
           "MCP ownership label missing")
    image = mcp.get("Config", {}).get("Image", "")
    import re
    ensure(re.fullmatch(r"vps-code-mcp:[a-f0-9]{40}", image) is not None,
           "Unexpected MCP image")
    bindings = mcp.get("HostConfig", {}).get("PortBindings", {}).get("8789/tcp")
    ensure(bindings == [{"HostIp": "127.0.0.1", "HostPort": "8789"}],
           "MCP must only bind host loopback")
    ensure(not mcp.get("HostConfig", {}).get("Privileged"),
           "Privileged MCP container denied")
    mounts = mcp.get("Mounts", [])
    ensure(any(m.get("Destination") == "/run/secrets/code-mcp-token" and
               m.get("RW") is False for m in mounts),
           "MCP token must be a read-only mount")
    ensure(tunnel.get("Name") == "/" + TUNNEL and tunnel.get("State", {}).get("Running"),
           "Cloudflare Tunnel not running")
    ensure(re.match(r"^cloudflare/cloudflared(?::|@|$)", tunnel.get("Config", {}).get("Image", "")),
           "Unexpected Cloudflare Tunnel image")
    ensure("vps_panel_control" in tunnel.get("NetworkSettings", {}).get("Networks", {}),
           "Cloudflare Tunnel control network missing")
    ensure(not any(m.get("Destination") == "/var/run/docker.sock"
                   for m in tunnel.get("Mounts", [])), "Tunnel has Docker socket")


def check_network(net):
    if net is None:
        return
    ensure(net.get("Name") == NETWORK and net.get("Internal") is True and
           net.get("Driver") == "bridge", "Unexpected network shape")
    ensure(net.get("Labels", {}).get(OWNER) == "true", "Network not owned by MCP setup")
    names = [entry.get("Name") for entry in (net.get("Containers") or {}).values()]
    ensure(all(n in (MCP, TUNNEL) for n in names),
           "Network contains unrelated project container")


def members(net):
    return {entry.get("Name") for entry in (net or {}).get("Containers", {}).values()}


class Edge:
    def __init__(self, docker=None):
        self.docker = docker or Docker()

    def check(self):
        check_container(self.docker.container(MCP), self.docker.container(TUNNEL))
        net = self.docker.network()
        check_network(net)
        names = members(net)
        return {
            "network": NETWORK, "internal": True, "origin": ORIGIN,
            "mcpAttached": MCP in names, "tunnelAttached": TUNNEL in names,
            "needsChanges": net is None or MCP not in names or TUNNEL not in names,
            "publicHttpsPublished": False
        }

    def apply(self):
        before = self.check()
        if not before["needsChanges"]:
            return dict(before, changed=False)
        created = False
        joined = []
        try:
            if self.docker.network() is None:
                self.docker.run("network", "create", "--driver", "bridge", "--internal",
                                "--label", OWNER + "=true", NETWORK)
                created = True
            self.check()
            if MCP not in members(self.docker.network()):
                self.docker.run("network", "connect", "--alias", ALIAS, NETWORK, MCP)
                joined.append(MCP)
            if TUNNEL not in members(self.docker.network()):
                self.docker.run("network", "connect", NETWORK, TUNNEL)
                joined.append(TUNNEL)
            after = self.check()
            ensure(after["mcpAttached"] and after["tunnelAttached"], "Network join incomplete")
            return dict(after, changed=True)
        except BaseException:
            for name in reversed(joined):
                try:
                    self.docker.run("network", "disconnect", NETWORK, name)
                except Exception:
                    pass
            if created:
                try:
                    self.docker.run("network", "rm", NETWORK)
                except Exception:
                    pass
            raise

    def rollback(self):
        mcp, tunnel = self.docker.container(MCP), self.docker.container(TUNNEL)
        ensure(mcp.get("Name") == "/" + MCP and
               mcp.get("Config", {}).get("Labels", {}).get("com.softdown.code-mcp.managed") == "true",
               "MCP container owner mismatch")
        ensure(tunnel.get("Name") == "/" + TUNNEL and
               tunnel.get("Config", {}).get("Image", "").startswith("cloudflare/cloudflared"),
               "Tunnel owner mismatch")
        net = self.docker.network()
        check_network(net)
        if not net:
            return {"network": NETWORK, "changed": False}
        for name in (TUNNEL, MCP):
            if name in members(net):
                self.docker.run("network", "disconnect", NETWORK, name)
        self.docker.run("network", "rm", NETWORK)
        return {"network": NETWORK, "changed": True}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("action", choices=["check", "apply", "rollback"], nargs="?", default="check")
    p.add_argument("confirmation", nargs="?")
    args = p.parse_args()
    if args.action != "check":
        required = "LINK:code-mcp" if args.action == "apply" else "UNLINK:code-mcp"
        ensure(os.geteuid() == 0 and args.confirmation == required,
               "Administrative root and explicit action confirmation required")
    else:
        ensure(args.confirmation is None, "Check does not accept confirmation")
    edge = Edge()
    result = edge.check() if args.action == "check" else (
        edge.apply() if args.action == "apply" else edge.rollback())
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("MCP edge operation denied: " + str(exc), file=sys.stderr)
        sys.exit(1)
