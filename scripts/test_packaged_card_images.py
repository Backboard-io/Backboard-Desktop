#!/usr/bin/env python3
"""Reject releases with missing or changed credit/billing card artwork."""
import argparse
import hashlib
from pathlib import Path

CARDS = {
    'backboardUpsell': ('card-signin.jpg', 'card-low.jpg', 'card-out.jpg'),
    'backboardBilling': ('plan-builder.jpg', 'plan-scale.jpg', 'plan-enterprise.jpg'),
}

def validate(app, source):
    verified = []
    for feature, names in CARDS.items():
        for name in names:
            relative = Path('vs/workbench/contrib') / feature / 'browser/media' / name
            original = source / relative
            packaged = app / 'Contents/Resources/app/out' / relative
            if not original.is_file() or not packaged.is_file():
                raise ValueError(f'Missing card artwork: {relative}')
            data = packaged.read_bytes()
            if not data.startswith(b'\xff\xd8\xff') or len(data) < 100:
                raise ValueError(f'Invalid JPEG card artwork: {relative}')
            if hashlib.sha256(data).digest() != hashlib.sha256(original.read_bytes()).digest():
                raise ValueError(f'Packaged card artwork differs from source: {relative}')
            verified.append(str(relative))
    return verified

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--source', type=Path, default=Path(__file__).resolve().parent.parent / 'backboard/src')
    args = parser.parse_args()
    for image in validate(args.app, args.source):
        print('PASS ' + image)
