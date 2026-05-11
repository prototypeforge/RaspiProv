"""Entry point: ``python -m pi_ble_config`` or the ``pi-ble-config`` script."""
from __future__ import annotations

import argparse
import asyncio
import logging
import signal
import sys

from .service import ProvisioningService, default_local_name


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="pi-ble-config")
    p.add_argument(
        "--name",
        default=None,
        help=f"BLE local name to advertise (default: {default_local_name()!r})",
    )
    p.add_argument(
        "-v", "--verbose",
        action="count",
        default=0,
        help="-v for INFO, -vv for DEBUG",
    )
    return p.parse_args(argv)


async def _amain(args: argparse.Namespace) -> int:
    svc = ProvisioningService(local_name=args.name)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, lambda: asyncio.create_task(svc.shutdown()))
    try:
        await svc.run()
    finally:
        await svc.shutdown()
    return 0


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    level = logging.WARNING
    if args.verbose == 1:
        level = logging.INFO
    elif args.verbose >= 2:
        level = logging.DEBUG
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    try:
        return asyncio.run(_amain(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
