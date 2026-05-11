"""
Build script. By default builds a pure-Python wheel.

Set PI_BLE_CONFIG_COMPILE=1 to compile the Python modules to native
extensions via Cython (produces .so files instead of .py in the wheel).
This is the "compiled Python package" mode.
"""
import os
from pathlib import Path
from setuptools import setup

COMPILE = os.environ.get("PI_BLE_CONFIG_COMPILE", "0") == "1"

if COMPILE:
    from Cython.Build import cythonize

    pkg_dir = Path(__file__).parent / "pi_ble_config"
    # Compile every module except __main__ (kept as .py so `python -m` works)
    # and __init__ (kept thin so import works without cimport tricks).
    sources = [
        str(p)
        for p in pkg_dir.glob("*.py")
        if p.name not in {"__init__.py", "__main__.py"}
    ]
    ext_modules = cythonize(
        sources,
        compiler_directives={
            "language_level": "3",
            "embedsignature": True,
        },
        build_dir="build/cython",
    )
    setup(ext_modules=ext_modules)
else:
    setup()
