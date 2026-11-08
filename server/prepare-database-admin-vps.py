#!/usr/bin/env python3
"""Explicit root-only bootstrap. Reloads PostgreSQL TLS/HBA; never restarts DB or edits existing rules.

Does not activate API flags. Install compose.postgres-admin-local.yaml last, preserving all overlays.
Requires the existing encrypted Terrania backup and keeps only small essential rollback configuration.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def run(args, **kw):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kw).stdout.strip()


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--apply', action='store_true')
    p.add_argument('--resume', action='store_true', help='Reuse the staged certificates after a configuration rollback; never regenerates keys.')
    args = p.parse_args()
    if os.geteuid() != 0:
        raise SystemExit('Execute como administrador do host.')
    pg = json.loads(run(['docker','inspect','vps-postgres']))[0]
    api = json.loads(run(['docker','inspect','softload-panel-api']))[0]
    if pg['HostConfig'].get('PortBindings'):
        raise SystemExit('PostgreSQL possui portas publicadas; revisar antes de habilitar.')
    panel_root = Path(next(m['Source'] for m in api['Mounts'] if m['Destination']=='/data'))
    pg_root = Path(next(m['Source'] for m in pg['Mounts'] if m['Destination']=='/var/lib/postgresql'))
    target = pg_root/'18/docker'
    if not (target/'PG_VERSION').is_file() or (target/'PG_VERSION').read_text().strip()!='18':
        raise SystemExit('Versão/diretório PostgreSQL diferente do auditado.')
    tls = panel_root/'postgres-tls'
    if tls.exists() and not args.resume:
        raise SystemExit('Certificados já existem. Não serão sobrescritos; confira a instalação.')
    if args.resume and not tls.is_dir():
        raise SystemExit('Não existe uma preparação anterior para retomar.')
    sql = lambda text: run(['docker','exec','vps-postgres','psql','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres','-Atc',text])
    contexts = sql("SELECT name||':'||context FROM pg_settings WHERE name IN ('ssl','ssl_cert_file','ssl_key_file','ssl_ca_file')")
    if contexts.count(':sighup')!=4:
        raise SystemExit('A configuração requer mais que reload; operação cancelada.')
    print(json.dumps({'preflight':'ok','postgres':'18','mode':'reload only','existing_clients':'preserved','apply':args.apply}))
    if not args.apply:
        return
    run(['systemctl','start','terrania-postgres-backup.service'])
    if not Path('/var/backups/terrania/latest.cms').is_file():
        raise SystemExit('Backup externo/encriptado existente não foi confirmado.')
    # Essential rollback configuration, not a copy of code, images, or database contents.
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    rollback = Path('/etc/vps-postgres-admin')/('rollback-'+stamp)
    rollback.mkdir(parents=True, mode=0o700)
    original_hba = (target/'pg_hba.conf').read_bytes()
    for name in ['pg_hba.conf','postgresql.auto.conf']:
        shutil.copy2(target/name,rollback/name)
    (rollback/'versions.json').write_text(json.dumps({'postgresImage':pg['Config']['Image'],
        'panelImage':api['Config']['Image'],'panelCompose':api['Config']['Labels'].get('com.docker.compose.project.config_files')}))
    for f in rollback.iterdir(): f.chmod(0o600)
    with tempfile.TemporaryDirectory(prefix='pg-panel-', dir='/run') as scratch:
        tmp=Path(scratch)
        def openssl(*a): run(['openssl',*a])
        if args.resume:
            for name in ['ca.key','ca.crt','admin.key','admin.crt']:
                if not (tls/name).is_file() or (tls/name).is_symlink() or (tls/name).stat().st_mode & 0o077:
                    raise RuntimeError('Certificados preparados ausentes ou sem proteção.')
            openssl('verify','-CAfile',str(tls/'ca.crt'),'-purpose','sslclient',str(tls/'admin.crt'))
        else:
            generate_certificates(tmp,tls,target,openssl)
    applied = False
    try:
        existing = sql("SELECT count(*) FROM pg_roles WHERE rolname IN ('panel_db_admin','vps_panel_certificate_clients')")
        if existing=='0':
            sql('CREATE ROLE vps_panel_certificate_clients NOLOGIN; CREATE ROLE panel_db_admin LOGIN SUPERUSER CONNECTION LIMIT 4 PASSWORD NULL;')
        elif not args.resume or existing!='2' or sql("SELECT count(*) FROM pg_roles WHERE (rolname='panel_db_admin' AND rolsuper AND rolcanlogin AND rolconnlimit=4) OR (rolname='vps_panel_certificate_clients' AND NOT rolsuper AND NOT rolcanlogin AND NOT rolcreaterole AND NOT rolcreatedb)")!='2':
            raise RuntimeError('Identidades administrativas diferentes da preparação; revisão necessária.')
        sql("ALTER SYSTEM SET ssl_cert_file='panel-tls/server.crt'")
        sql("ALTER SYSTEM SET ssl_key_file='panel-tls/server.key'")
        sql("ALTER SYSTEM SET ssl_ca_file='panel-tls/ca.crt'")
        sql("ALTER SYSTEM SET ssl='on'")
        # HBA validation sees the current live SSL setting. Enable TLS first with
        # the original rules, otherwise hostssl rows are reported as errors.
        sql('SELECT pg_reload_conf()')
        import time
        time.sleep(2)
        if sql('SHOW ssl')!='on': raise RuntimeError('Servidor não confirmou SSL.')
        prefix = '# BEGIN VPS PANEL CERTIFICATE LANE (existing client rules follow unchanged)\n'
        for cidr in ['0.0.0.0/0','::/0']:
            for identity in ['panel_db_admin','+vps_panel_certificate_clients']:
                prefix += f'hostssl all {identity} {cidr} cert\nhost all {identity} {cidr} reject\n'
        prefix += '# END VPS PANEL CERTIFICATE LANE\n'
        hba=target/'pg_hba.conf';hba.write_bytes(prefix.encode()+original_hba)
        if sql('SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL')!='0':
            raise RuntimeError('HBA inválido; cancelando.')
        sql('SELECT pg_reload_conf()');time.sleep(1)
        applied=True
        print(json.dumps({'installed':True,'postgresRestarted':False,'rollback':str(rollback),'apiActivation':'pending',
          'existingHbaSuffixPreserved':hba.read_bytes().endswith(original_hba)}))
    finally:
        if not applied:
            for name in ['pg_hba.conf','postgresql.auto.conf']: shutil.copy2(rollback/name,target/name)
            sql('SELECT pg_reload_conf()')
            print('Configuração anterior restaurada. Certificados/identidades não são apagados automaticamente.')


def generate_certificates(tmp,tls,target,openssl):
    openssl('req','-x509','-newkey','rsa:3072','-nodes','-keyout',str(tmp/'ca.key'),'-out',str(tmp/'ca.crt'),'-days','1825','-sha256','-subj','/CN=VPS Panel PostgreSQL CA',
            '-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign')
    for name,cn,purpose,extra in [('server','vps-postgres','serverAuth','subjectAltName=DNS:vps-postgres'),('admin','panel_db_admin','clientAuth','')]:
        openssl('req','-new','-newkey','rsa:3072','-nodes','-keyout',str(tmp/(name+'.key')),'-out',str(tmp/(name+'.csr')),'-subj','/CN='+cn)
        (tmp/(name+'.ext')).write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage='+purpose+'\n'+extra+'\n')
        openssl('x509','-req','-in',str(tmp/(name+'.csr')),'-CA',str(tmp/'ca.crt'),'-CAkey',str(tmp/'ca.key'),'-set_serial','0x'+os.urandom(16).hex(),'-out',str(tmp/(name+'.crt')),'-days','365','-sha256','-extfile',str(tmp/(name+'.ext')))
    tls.mkdir(mode=0o700)
    for name in ['ca.key','ca.crt','admin.key','admin.crt']:
        shutil.copyfile(tmp/name,tls/name);(tls/name).chmod(0o600)
    server = target/'panel-tls';server.mkdir(mode=0o700)
    uid = int(run(['docker','exec','vps-postgres','id','-u','postgres']))
    gid = int(run(['docker','exec','vps-postgres','id','-g','postgres']))
    os.chown(server,uid,gid)
    for name in ['ca.crt','server.key','server.crt']:
        shutil.copyfile(tmp/name,server/name);(server/name).chmod(0o600);os.chown(server/name,uid,gid)

if __name__ == '__main__':
    main()
