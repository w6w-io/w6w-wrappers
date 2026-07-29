"""Test suite for the `w6w` client.

Runs with no installation step and no third-party runner:

    PYTHONPATH=src python3 -m unittest discover -s tests -t . -v

`-t .` makes the repository root the top-level directory, which is why this
file exists: it makes `tests` a package so discovery imports test modules as
`tests.test_*` rather than adding `tests/` itself to `sys.path`.

No test in this suite may reach the network. Client behaviour is exercised
against an injected transport seam, never a live server.
"""
