import unittest
from edge_network import Edge, NETWORK, MCP, TUNNEL, ORIGIN
class Fake:
    def __init__(self):
        self.commands=[]
        self.net=None
        self.mcp={
            "Name":"/"+MCP,"State":{"Running":True,"Health":{"Status":"healthy"}},
            "Config":{"Image":"vps-code-mcp:"+"a"*40,
                      "Labels":{"com.softdown.code-mcp.managed":"true"}},
            "HostConfig":{"PortBindings":{"8789/tcp":[{"HostIp":"127.0.0.1",
            "HostPort":"8789"}]},"Privileged":False},
            "Mounts":[{"Destination":"/run/secrets/code-mcp-token","RW":False}]
        }
        self.tunnel={
            "Name":"/"+TUNNEL,"State":{"Running":True},
            "Config":{"Image":"cloudflare/cloudflared:latest"},
            "NetworkSettings":{"Networks":{"vps_panel_control":{}}},
            "Mounts":[]
        }
    def container(self,name):
        return self.mcp if name==MCP else self.tunnel
    def network(self):
        return self.net
    def run(self,*args):
        self.commands.append(args)
        if args[0:2]==("network","create"):
            self.net={"Name":NETWORK,"Internal":True,"Driver":"bridge",
               "Labels":{"com.softdown.code-mcp.edge":"true"},"Containers":{}}
        if args[0:2]==("network","connect"):
            name=args[-1]
            self.net["Containers"][name]={"Name":name}
        if args[0:2]==("network","disconnect"):
            self.net["Containers"].pop(args[-1],None)
        if args[0:2]==("network","rm"):
            assert not self.net["Containers"]
            self.net=None

class EdgeTest(unittest.TestCase):
    def test_dry_run_idempotent_and_reverse(self):
        f=Fake()
        edge=Edge(f)
        self.assertEqual(edge.check()["origin"],ORIGIN)
        self.assertFalse(f.commands)
        self.assertTrue(edge.apply()["changed"])
        self.assertTrue(edge.check()["mcpAttached"])
        self.assertTrue(edge.check()["tunnelAttached"])
        self.assertFalse(edge.apply()["changed"])
        self.assertEqual(sum(c[:2]==("network","connect") for c in f.commands),2)
        self.assertTrue(edge.rollback()["changed"])
        self.assertIsNone(f.net)
        self.assertFalse(edge.rollback()["changed"])
    def test_denies_foreign_network(self):
        f=Fake()
        f.net={"Name":NETWORK,"Internal":False,"Driver":"bridge",
            "Labels":{"com.softdown.code-mcp.edge":"true"},"Containers":{}}
        with self.assertRaisesRegex(RuntimeError,"network shape"):
            Edge(f).apply()
        self.assertFalse(f.commands)
    def test_denies_unrelated_container(self):
        f=Fake()
        f.net={"Name":NETWORK,"Internal":True,"Driver":"bridge",
            "Labels":{"com.softdown.code-mcp.edge":"true"},
            "Containers":{"x":{"Name":"vps-postgres"}}}
        with self.assertRaisesRegex(RuntimeError,"unrelated"):
            Edge(f).apply()
        self.assertFalse(f.commands)
    def test_denies_external_mcp_public_port(self):
        f=Fake()
        f.mcp["HostConfig"]["PortBindings"]["8789/tcp"][0]["HostIp"]="0.0.0.0"
        with self.assertRaisesRegex(RuntimeError,"loopback"):
            Edge(f).apply()
        self.assertFalse(f.commands)
    def test_denies_docker_socket_tunnel(self):
        f=Fake()
        f.tunnel["Mounts"]=[{"Destination":"/var/run/docker.sock"}]
        with self.assertRaisesRegex(RuntimeError,"Docker socket"):
            Edge(f).apply()
    def test_rollback_unhealthy_mcp(self):
        f=Fake()
        e=Edge(f)
        e.apply()
        f.mcp["State"]["Health"]["Status"]="unhealthy"
        self.assertTrue(e.rollback()["changed"])
        self.assertIsNone(f.net)

if __name__=="__main__":
    unittest.main()
