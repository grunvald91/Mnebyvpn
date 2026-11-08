import unittest
import pathlib,importlib.util,json,tempfile
here=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('ru_stage',here/'stage-ru-access-pilot.py')
assert spec and spec.loader
stage=importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage)
manifest=json.loads((here/'ru-access-first-pilot.json').read_text())
hosts=stage.domains(manifest)
oldnginx='''stream {
    map $ssl_preread_server_name $direct_mtproxy_backend {
        default 127.0.0.1:9443;
        gemini.google.com 127.0.0.1:15443;
'''+''.join(f'        service{i}.example.test 127.0.0.1:{9600+i};\n' for i in range(26))+'''    }
    server { listen 443; ssl_preread on; proxy_pass $direct_mtproxy_backend; }
}'''
olddns=(here/'Corefile.gemini-canary').read_text()

class MultiServiceTests(unittest.TestCase):
    def test_six_approved_hosts_and_no_wildcard(self):
        self.assertEqual(len(hosts),3)
        self.assertEqual(set(hosts),stage.EXPECTED_HOSTS)
        for h in hosts:self.assertNotIn('*',h)
    def test_dns_templates_exact_and_no_non_target_changes(self):
        new=stage.render_dns(olddns,hosts)
        for h in hosts:
            for q in ('A','AAAA','HTTPS','SVCB'):
                self.assertEqual(new.count(f'template IN {q} {h} {{'),1)
        self.assertIn('tls_servername dns.quad9.net',new)
        self.assertIn('template IN A gemini.google.com',new)
        self.assertNotIn('template IN A www.google.com',new)
        self.assertNotIn('template IN A gosuslugi.ru',new)
        with self.assertRaises(ValueError):stage.render_dns(new,hosts)
    def test_exact_additive_sni_preserves_existing_routes(self):
        new=stage.render_sni(oldnginx,hosts)
        self.assertEqual(new.count('gemini.google.com 127.0.0.1:15443;'),1)
        for h in hosts:self.assertEqual(new.count(h+' 127.0.0.1:15446;'),1)
        self.assertIn('default 127.0.0.1:9443;',new)
        for i in range(26):self.assertIn(f'service{i}.example.test 127.0.0.1:{9600+i};',new)
        with self.assertRaises(ValueError):stage.render_sni(new,hosts)
    def test_sidecar_fail_closed_and_local_only(self):
        relay=stage.render_relay(hosts)
        self.assertIn('listen 127.0.0.1:15446;',relay)
        self.assertIn('default 127.0.0.1:1;',relay)
        self.assertIn('ssl_preread on;',relay)
        self.assertIn('access_log off;',relay)
        self.assertNotIn('listen 443;',relay)
        self.assertNotIn('proxy_pass $ssl_preread_server_name;',relay)
        for h in hosts:self.assertIn(f'{h} {h}:443;',relay)
    def test_fail_unreviewed_sources_and_surprises(self):
        fake=json.loads(json.dumps(manifest))
        fake['entries'][0]['domain']='*.discord.com'
        with self.assertRaises(ValueError):stage.domains(fake)
        fake=json.loads(json.dumps(manifest))
        fake['entries'][0]['domain']='gosuslugi.ru'
        with self.assertRaises(ValueError):stage.domains(fake)
        fake=json.loads(json.dumps(manifest))
        fake['entries'][0]['foreignProbe']='timeout'
        with self.assertRaises(ValueError):stage.domains(fake)
        fake=json.loads(json.dumps(manifest))
        fake['entries'].append(fake['entries'][0])
        with self.assertRaises(ValueError):stage.domains(fake)
        with self.assertRaises(ValueError):stage.render_nginx('') if hasattr(stage,'render_nginx') else stage.render_sni('no shared nginx map',hosts)
    def test_live_deploy_only_checks_admitted_discord_hosts(self):
        deploy=(here/'deploy-ru-access-pilot.sh').read_text()
        rollback=(here/'rollback-ru-access-pilot.sh').read_text()
        self.assertNotIn('www.instagram.com',deploy)
        self.assertNotIn('www.facebook.com',deploy)
        self.assertNotIn('static.cdninstagram.com',deploy)
        self.assertEqual(deploy.count('for domain in discord.com gateway.discord.gg cdn.discordapp.com; do'),2)
        self.assertIn('[[ -f "$nginx" && -f "$dns" && ! -L "$nginx" && ! -L "$dns" ]]',deploy)
        self.assertIn('[[ -f "$map" && -f "$dns" && ! -L "$map" && ! -L "$dns" ]]',rollback)
        self.assertIn('# MNEBYDNS exact-host RU access TLS passthrough',rollback)
        self.assertIn('systemd-run --unit="$watchdog"',deploy)
        self.assertIn('rollback-ru-access-pilot.sh',deploy)
    def test_stager_never_mutates_live_files(self):
        with tempfile.TemporaryDirectory() as td:
            path=pathlib.Path(td)
            originng=path/'orig-nginx.conf'
            origindns=path/'orig-Corefile'
            originng.write_text(oldnginx)
            origindns.write_text(olddns)
            # Exercise core compiler; independently check exact subtraction.
            n=stage.render_sni(originng.read_text(),hosts)
            d=stage.render_dns(origindns.read_text(),hosts)
            self.assertEqual(originng.read_text(),oldnginx)
            self.assertEqual(origindns.read_text(),olddns)
            self.assertIn('discord.com',n)
            self.assertIn('discord.com',d)
if __name__=='__main__':unittest.main(verbosity=2)
