#!/usr/bin/env python3
"""Read-only Cloudflare WAF event probe using existing GitHub Action token.
No account modification, no printing account IDs, API token, IPs or headers.
"""
import datetime as dt
import json
import os
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.cloudflare.com/client/v4"
HOST = "analysepro.com"
START = "2026-10-31T23:14:00Z"
END = "2026-10-31T23:36:00Z"
QUERY = """query RecentMcpSecurity($zoneTag: string, $filter: FirewallEventsAdaptiveFilter_InputObject) {
 viewer {
  zones(filter: { zoneTag: $zoneTag }) {
   firewallEventsAdaptive(filter: $filter, limit: 100, orderBy: [datetime_DESC]) {
    action datetime source clientRequestPath
   }
  }
 }
}"""


def api(path, token, payload=None):
    assert path.startswith("/"), "API path must be relative"
    headers = {"Authorization": "Bearer " + token,
               "Accept": "application/json",
               "Content-Type": "application/json"}
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(API + path, headers=headers, data=data,
                                 method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=18) as res:
            return res.status, json.load(res)
    except urllib.error.HTTPError as exc:
        try:
            obj = json.loads(exc.read(4096))
        except Exception:
            obj = {}
        return exc.code, obj


def summarize_events(events):
    matches = [e for e in events if e.get("clientRequestPath") == "/mcp"]
    return {
        "sampled_event_count": len(events),
        "mcp_event_count": len(matches),
        "events": [
            {
                "action": str(e.get("action", ""))[:32],
                "source": str(e.get("source", ""))[:32],
                "datetime": str(e.get("datetime", ""))[:32],
            }
            for e in matches[:15]
        ],
        "sampling_warning": "Absence of an event is not proof no Cloudflare rule ran."
    }


def main():
    token = os.getenv("CLOUDFLARE_API_TOKEN", "")
    report = {"domain": HOST, "window": [START, END], "read_only": True}
    if not token:
        report["result"] = "cloudflare-api-token-not-configured-in-github"
    else:
        status, obj = api("/zones?name=" + urllib.parse.quote(HOST) + "&per_page=5", token)
        report["zone_lookup_http"] = status
        zones = obj.get("result", []) if isinstance(obj, dict) else []
        zone = next((z for z in zones if z.get("name") == HOST), None) if isinstance(zones, list) else None
        if not zone:
            report["result"] = "zone-not-readable-with-current-token"
        else:
            zone_id = zone["id"]
            query = {"query": QUERY, "variables": {
                "zoneTag": zone_id,
                "filter": {"datetime_geq": START, "datetime_leq": END}
            }}
            status, obj = api("/graphql", token, query)
            report["analytics_http"] = status
            errors = obj.get("errors") or []
            if errors:
                report["result"] = "analytics-query-rejected-or-permission-denied"
                report["error_codes"] = [
                    str(e.get("extensions", {}).get("code", "unknown"))[:40]
                    for e in errors[:4] if isinstance(e, dict)
                ]
            else:
                z = (((obj.get("data") or {}).get("viewer") or {}).get("zones") or [])
                if z:
                    events = z[0].get("firewallEventsAdaptive") or []
                    report.update(summarize_events(events))
                    report["result"] = "query-completed"
                else:
                    report["result"] = "zone-analytics-not-available"
    print(json.dumps(report, indent=2))
    with open("mcp-cloudflare-security-diagnostic.json", "w") as f:
        json.dump(report, f, indent=2)
        f.write("\n")


if __name__ == "__main__":
    main()
