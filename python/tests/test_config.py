"""Configuration resolution, against an **injected environment mapping**.

Nothing here reads or mutates the real process environment: every case passes
its own `environ=` dict, so the whole precedence chain is exercised twice in one
process without a `patch.dict` in sight. (The single exception is
`test_the_default_source_is_the_process_environment`, which asserts an
*identity* — it reads no variable and changes nothing.)

The blank-is-absent rule gets three separate cases plus the unset one, because
testing only the unset case is exactly the gap that lets `W6W_BASE_URL=` through
to a relative `"/api"`.
"""

from __future__ import annotations

import os
import unittest
from typing import Dict

from w6w import BASE_PATH, ConfigError, join_base_url
from w6w._config import ResolvedConfig, require_token, resolve_config
from w6w._env import ENV_BASE_URL, ENV_TOKEN, process_environ, read_env

#: An environment with nothing in it — the "unset" case, stated once.
EMPTY: Dict[str, str] = {}


class JoinBaseUrlTest(unittest.TestCase):
    """`W6W_BASE_URL` holds an origin; since 0.2.0 the wrapper appends nothing."""

    def test_an_origin_is_used_as_is(self) -> None:
        self.assertEqual(join_base_url("https://api.example.com"), "https://api.example.com")
        self.assertEqual(BASE_PATH, "")

    def test_trailing_slashes_are_stripped(self) -> None:
        # One slash and many: `url.replace(/\\/+$/, "")` in the house helper.
        self.assertEqual(join_base_url("https://api.example.com/"), "https://api.example.com")
        self.assertEqual(join_base_url("https://api.example.com///"), "https://api.example.com")

    def test_a_stale_api_path_is_preserved_not_stripped(self) -> None:
        # Nothing is appended, so nothing can be doubled; the risk runs the
        # other way now. A "/api" carried over from 0.1.x is indistinguishable
        # from a real gateway prefix, so it is preserved verbatim and left to
        # 404 rather than be guessed at. Only trailing slashes come off.
        self.assertEqual(
            join_base_url("https://api.example.com/api"),
            "https://api.example.com/api",
        )
        self.assertEqual(
            join_base_url("https://api.example.com/api/"),
            "https://api.example.com/api",
        )

    def test_a_sub_path_origin_is_respected(self) -> None:
        # Behind a reverse proxy the API can live under a prefix; whatever path
        # was configured is carried through untouched.
        self.assertEqual(
            join_base_url("https://example.com/w6w"),
            "https://example.com/w6w",
        )
        self.assertEqual(
            join_base_url("https://api.example.com/apiary"),
            "https://api.example.com/apiary",
        )

    def test_the_exported_helper_is_the_same_code_path_the_client_uses(self) -> None:
        # A helper that is merely *similar* to the client's path is worse than
        # no helper: a caller importing it to predict a URL would get a
        # different answer than their client actually uses. Padded input is the
        # case that separates the two (the trim used to live only in the
        # resolver), so it is the case asserted.
        # Note the two assertions per case. Equality alone does NOT discriminate
        # once the two share an implementation — removing the trim from the
        # helper would move both answers together and the comparison would still
        # hold. The expected *value* is what pins the trim.
        for origin, expected in (
            ("  https://api.example.com/  ", "https://api.example.com"),
            ("https://api.example.com", "https://api.example.com"),
            ("\thttps://x.io\n", "https://x.io"),
        ):
            with self.subTest(origin=repr(origin)):
                self.assertEqual(join_base_url(origin), expected)
                self.assertEqual(
                    join_base_url(origin),
                    resolve_config(base_url=origin, environ=EMPTY).base_url,
                )
        # And the error paths agree too, not only the happy ones.
        for bad in ("", "   ", "/foo"):
            with self.subTest(origin=repr(bad)):
                with self.assertRaises(ConfigError) as from_helper:
                    join_base_url(bad)
                with self.assertRaises(ConfigError) as from_resolver:
                    resolve_config(base_url=bad, environ=EMPTY)
                self.assertEqual(str(from_helper.exception), str(from_resolver.exception))


class AbsoluteBaseUrlTest(unittest.TestCase):
    """A relative or host-only base URL is a configuration error, said as such."""

    def test_a_relative_base_url_is_rejected_at_configuration_time(self) -> None:
        # Blank-is-absent already stops "" from joining to the relative "/api".
        # Without this check, `W6W_BASE_URL=/foo` walks straight past that guard
        # to "/foo/api" and fails on the first request as "the server may be
        # down" — the same hole by another route, and misdiagnosed.
        for value in ("/foo", "/", "foo/bar", "api.example.com", "//api.example.com"):
            with self.subTest(value=value):
                with self.assertRaises(ConfigError) as caught:
                    resolve_config(base_url=value, environ=EMPTY)
                message = str(caught.exception)
                self.assertIn(ENV_BASE_URL, message)
                # It must diagnose *configuration*, not connectivity.
                self.assertNotIn("unreachable", message)
                self.assertNotIn("may be down", message)

    def test_a_non_http_scheme_is_rejected(self) -> None:
        # "localhost:8080" parses as scheme "localhost" — the classic near-miss,
        # and the reason the check is scheme-allowlist plus netloc rather than
        # "has a colon".
        for value in ("ftp://api.example.com", "file:///etc/passwd", "localhost:8080"):
            with self.subTest(value=value):
                with self.assertRaises(ConfigError):
                    resolve_config(base_url=value, environ=EMPTY)

    def test_http_and_https_origins_are_accepted(self) -> None:
        self.assertEqual(
            resolve_config(base_url="http://localhost:8080").base_url,
            "http://localhost:8080",
        )
        self.assertEqual(
            resolve_config(base_url="https://api.example.com").base_url,
            "https://api.example.com",
        )


class PrecedenceTest(unittest.TestCase):
    """Explicit argument > environment variable > (no default)."""

    def test_the_environment_supplies_the_base_url_and_token(self) -> None:
        config = resolve_config(
            environ={ENV_BASE_URL: "https://env.example.com", ENV_TOKEN: "tok_env"},
        )
        self.assertEqual(config.base_url, "https://env.example.com")
        self.assertEqual(config.token, "tok_env")
        self.assertIsNone(config.project)

    def test_an_explicit_argument_beats_the_environment(self) -> None:
        config = resolve_config(
            base_url="https://explicit.example.com",
            token="tok_explicit",
            project="prj_1",
            environ={ENV_BASE_URL: "https://env.example.com", ENV_TOKEN: "tok_env"},
        )
        self.assertEqual(config.base_url, "https://explicit.example.com")
        self.assertEqual(config.token, "tok_explicit")
        self.assertEqual(config.project, "prj_1")

    def test_the_resolved_config_is_frozen(self) -> None:
        # Instance state, and immutable: nothing downstream may re-point a
        # client at another server or swap its credential in place.
        config = resolve_config(base_url="https://api.example.com", token="tok_1")
        with self.assertRaises(Exception):
            config.token = "tok_2"  # type: ignore[misc]

    def test_two_configs_in_one_process_do_not_interfere(self) -> None:
        # The module-global-credential regression, caught at the config layer.
        first = resolve_config(base_url="https://one.example.com", token="tok_1")
        second = resolve_config(base_url="https://two.example.com", token="tok_2")
        self.assertEqual(first.base_url, "https://one.example.com")
        self.assertEqual(first.token, "tok_1")
        self.assertEqual(second.base_url, "https://two.example.com")
        self.assertEqual(second.token, "tok_2")


class MissingBaseUrlTest(unittest.TestCase):
    """A missing or blank base URL is a configuration error naming `W6W_BASE_URL`."""

    def test_no_base_url_anywhere_raises_naming_the_variable(self) -> None:
        with self.assertRaises(ConfigError) as caught:
            resolve_config(environ=EMPTY)
        message = str(caught.exception)
        self.assertIn(ENV_BASE_URL, message)
        # It must also say what the value *is*, since "origin, not base path" is
        # the mistake the message exists to pre-empt.
        self.assertIn(BASE_PATH, message)

    def test_blank_env_values_are_absent_exactly_like_an_unset_one(self) -> None:
        # Three blank spellings plus unset, asserted to behave IDENTICALLY.
        # `export W6W_BASE_URL=`, a Dockerfile `ENV W6W_BASE_URL=` with no build
        # arg and an uninterpolated CI variable all produce a set-but-empty
        # variable that nobody chose — and it looks absent in every log line.
        cases = {
            "empty string": {ENV_BASE_URL: ""},
            "whitespace only": {ENV_BASE_URL: "   "},
            "newline only": {ENV_BASE_URL: "\n"},
            "unset": EMPTY,
        }
        messages = {}
        for label, environ in cases.items():
            with self.subTest(label):
                with self.assertRaises(ConfigError) as caught:
                    resolve_config(environ=environ)
                self.assertIn(ENV_BASE_URL, str(caught.exception))
                messages[label] = str(caught.exception)
        self.assertEqual(len(set(messages.values())), 1, messages)

    def test_no_blank_value_ever_resolves_to_a_relative_url(self) -> None:
        # The trap, made explicit: a NAIVE join of a blank value yields an
        # EMPTY base, so every request goes out relative — the browser
        # same-origin default a library must not have. It would not fail at
        # construction with a message naming the variable; it would fail later,
        # inside some operation, with a message about a request. Neither the
        # helper nor the resolver will produce it.
        self.assertEqual("".rstrip("/") + BASE_PATH, "")  # what NOT to do
        with self.assertRaises(ConfigError):
            join_base_url("")
        for environ in ({ENV_BASE_URL: ""}, {ENV_BASE_URL: "   "}, EMPTY):
            with self.subTest(environ=environ):
                with self.assertRaises(ConfigError):
                    resolve_config(environ=environ)
        # And every value that *does* resolve is absolute.
        resolved = resolve_config(base_url="https://api.example.com", environ=EMPTY)
        self.assertTrue(resolved.base_url.startswith("https://"), resolved.base_url)

    def test_an_explicit_empty_string_does_not_fall_through_to_the_environment(self) -> None:
        # The asymmetry: a blank ENV var is "absent", a blank ARGUMENT is an
        # explicit value. It must not quietly consult the environment behind the
        # caller's back — it raises, even though the env var is perfectly good.
        with self.assertRaises(ConfigError):
            resolve_config(base_url="", environ={ENV_BASE_URL: "https://env.example.com"})
        with self.assertRaises(ConfigError):
            resolve_config(base_url="   ", environ={ENV_BASE_URL: "https://env.example.com"})


class TokenTest(unittest.TestCase):
    """`W6W_TOKEN` resolution and the "no token" error."""

    def test_require_token_returns_the_configured_token_verbatim(self) -> None:
        config = resolve_config(base_url="https://api.example.com", token=" tok_1 ")
        # Trimming applies to the emptiness test, not to the stored value.
        self.assertEqual(config.token, " tok_1 ")
        self.assertEqual(require_token(config), " tok_1 ")

    def test_a_client_with_no_token_is_configurable_and_fails_only_on_use(self) -> None:
        # Constructible so a CLI's --help and --version work offline.
        config = resolve_config(base_url="https://api.example.com", environ=EMPTY)
        self.assertIsNone(config.token)
        with self.assertRaises(ConfigError) as caught:
            require_token(config)
        self.assertIn(ENV_TOKEN, str(caught.exception))

    def test_blank_tokens_are_absent_exactly_like_an_unset_one(self) -> None:
        # The same three-cases-plus-unset rule as the base URL.
        cases = {
            "empty string": {ENV_TOKEN: ""},
            "whitespace only": {ENV_TOKEN: "   "},
            "newline only": {ENV_TOKEN: "\n"},
            "unset": EMPTY,
        }
        for label, environ in cases.items():
            with self.subTest(label):
                config = resolve_config(base_url="https://api.example.com", environ=environ)
                self.assertIsNone(config.token)
                with self.assertRaises(ConfigError) as caught:
                    require_token(config)
                self.assertIn(ENV_TOKEN, str(caught.exception))

    def test_a_token_carrying_a_control_character_is_rejected_as_configuration(self) -> None:
        # CR/LF in a header value is HTTP header injection, and it arrives the
        # way secrets usually do: $(cat token.txt) with a trailing newline, a
        # copy-paste, a two-line CI variable. `http.client` does reject CR/LF —
        # but only when the request is SENT, and as a bare ValueError from
        # outside this package's error model. This suite never sends, so
        # delegating the check would mean no check at all here.
        for label, token in (
            ("carriage return", "tok\r_1"),
            ("newline", "tok\n_1"),
            ("nul", "tok\x00_1"),
            ("crlf injection", "tok\r\nX-Injected: yes"),
            ("trailing newline from a file", "tok_1\n"),
            ("vertical tab", "tok\x0b_1"),
            ("delete", "tok\x7f_1"),
        ):
            with self.subTest(label):
                config = resolve_config(base_url="https://api.example.com", token=token)
                with self.assertRaises(ConfigError) as caught:
                    require_token(config)
                message = str(caught.exception)
                self.assertIn(ENV_TOKEN, message)
                self.assertIn("control character", message)
                # The message lands in logs: it names the codepoint, never the
                # token.
                self.assertNotIn(token, message)

    def test_a_token_that_cannot_be_sent_as_latin_1_is_rejected(self) -> None:
        config = resolve_config(base_url="https://api.example.com", token="tok_十")
        with self.assertRaises(ConfigError) as caught:
            require_token(config)
        self.assertIn(ENV_TOKEN, str(caught.exception))

    def test_an_ordinary_token_survives_the_header_validation(self) -> None:
        # The check must not be so eager that a real credential fails it:
        # JWTs and opaque tokens carry dots, dashes, underscores and equals.
        token = "eyJhbGciOi.J9-_x=.sig~+/"
        config = resolve_config(base_url="https://api.example.com", token=token)
        self.assertEqual(require_token(config), token)

    def test_an_explicit_blank_token_is_an_explicit_value_and_still_fails(self) -> None:
        config = resolve_config(
            base_url="https://api.example.com",
            token="",
            environ={ENV_TOKEN: "tok_env"},
        )
        self.assertEqual(config.token, "")  # did NOT fall through to the env
        with self.assertRaises(ConfigError):
            require_token(config)


class ReadEnvTest(unittest.TestCase):
    """The one environment seam, exercised directly."""

    def test_a_present_value_is_returned_verbatim(self) -> None:
        self.assertEqual(read_env("X", {"X": "  spaced  "}), "  spaced  ")

    def test_blank_and_missing_values_read_as_none(self) -> None:
        for value in ("", "   ", "\n", "\t "):
            with self.subTest(value=repr(value)):
                self.assertIsNone(read_env("X", {"X": value}))
        self.assertIsNone(read_env("X", EMPTY))

    def test_the_default_source_is_the_process_environment(self) -> None:
        # An identity assertion only: it reads no variable's value and mutates
        # nothing, so the suite still has no dependence on ambient state. It
        # exists because the alternative failure — the default source silently
        # becoming an empty dict — would make every env var in production read
        # as unset while every test still passed.
        self.assertIs(process_environ(), os.environ)


class ProjectTest(unittest.TestCase):
    """`project` is an argument only — there is no `W6W_PROJECT`."""

    def test_project_has_no_environment_variable(self) -> None:
        config = resolve_config(
            base_url="https://api.example.com",
            environ={"W6W_PROJECT": "prj_from_env"},
        )
        self.assertIsNone(config.project)

    def test_project_is_carried_through(self) -> None:
        config = resolve_config(base_url="https://api.example.com", project="prj_1")
        self.assertIsInstance(config, ResolvedConfig)
        self.assertEqual(config.project, "prj_1")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
