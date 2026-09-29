#!/usr/bin/env python3
"""Prompt locally for AWS credentials and verify before saving the release profile."""

import argparse
import configparser
import getpass
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def save_profile(file_path, section, values, remove=()):
    config = configparser.RawConfigParser()
    if file_path.exists():
        with file_path.open() as source:
            config.read_file(source)
    if not config.has_section(section):
        config.add_section(section)
    for key in remove:
        config.remove_option(section, key)
    for key, value in values.items():
        config.set(section, key, value)
    file_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.release-', dir=file_path.parent)
    try:
        with os.fdopen(descriptor, 'w') as target:
            config.write(target)
        os.replace(temporary, file_path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    aws = shutil.which('aws')
    if not aws:
        sys.exit('AWS CLI is required. Install it, then run this script again.')
    if not sys.stdin.isatty():
        sys.exit('Run this script directly in your terminal so keys stay out of logs.')
    profile = 'backboard-release'
    region = 'ca-central-1'
    print(f'Configure AWS profile: {profile} ({region})')
    print('Paste each value at its prompt. Input is hidden and is not saved in shell history.')
    access_key = getpass.getpass('AWS access key ID: ').strip()
    secret_key = getpass.getpass('AWS secret access key: ').strip()
    session_token = getpass.getpass('Session token (temporary credentials only; otherwise press Enter): ').strip()
    if not access_key or not secret_key:
        sys.exit('Both keys are required. Nothing was saved.')
    environment = {key: value for key, value in os.environ.items() if not key.startswith('AWS_')}
    environment.update({
        'AWS_ACCESS_KEY_ID': access_key,
        'AWS_SECRET_ACCESS_KEY': secret_key,
        'AWS_DEFAULT_REGION': region,
        'AWS_CONFIG_FILE': os.devnull,
        'AWS_SHARED_CREDENTIALS_FILE': os.devnull,
        'AWS_EC2_METADATA_DISABLED': 'true',
        'AWS_PAGER': '',
    })
    if session_token:
        environment['AWS_SESSION_TOKEN'] = session_token
    print('Verifying credentials with AWS…')
    result = subprocess.run(
        [aws, 'sts', 'get-caller-identity', '--output', 'json',
         '--cli-connect-timeout', '10', '--cli-read-timeout', '20'],
        env=environment, capture_output=True, text=True, timeout=60,
    )
    if result.returncode:
        sys.exit('AWS could not verify those credentials. Nothing was saved. Check the keys and session token, then retry.')
    identity = json.loads(result.stdout)
    print(f'Authenticated AWS account: {identity["Account"]}')
    print(f'Identity: {identity["Arn"]}')
    credentials = {'aws_access_key_id': access_key, 'aws_secret_access_key': secret_key}
    if session_token:
        credentials['aws_session_token'] = session_token
    aws_directory = Path.home() / '.aws'
    save_profile(aws_directory / 'credentials', profile, credentials,
                 remove=('aws_session_token', 'aws_security_token'))
    save_profile(aws_directory / 'config', f'profile {profile}',
                 {'region': region, 'output': 'json'},
                 remove=('login_session', 'role_arn', 'source_profile', 'credential_source',
                         'credential_process', 'web_identity_token_file', 'sso_session',
                         'sso_start_url', 'sso_region', 'sso_account_id', 'sso_role_name'))
    print('Verified credentials saved in ~/.aws with owner-only file permissions.')
    print('Your default profile is unchanged. Tell Codex “ready” to publish Sandbox.')


if __name__ == '__main__':
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        sys.exit('\nCancelled.')
    except subprocess.TimeoutExpired:
        sys.exit('AWS verification timed out. Nothing was saved; please retry.')
