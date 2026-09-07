"""
Every environment variable the application reads, in one place.

Two rules this file exists to enforce:

* **Nothing is configured in code.** A deployment differs from a laptop by
  environment variables only - the same image, the same build.
* **The defaults are the local development setup**, so a fresh clone runs with
  no `.env` at all. `docs/DEPLOY.md` lists what a deployment must override.

`.env.example` documents the same variables for a human. If you add one here,
add it there.
"""
from typing import Annotated

from pydantic import field_validator
from pydantic_settings import BaseSettings, NoDecode


class Settings(BaseSettings):
    PROJECT_NAME: str = "Dynamic Workflow Intelligence"
    VERSION: str = "1.0.0"
    #: "development" or "production". Only affects how much detail an
    #: unexpected 500 puts in the response body.
    ENVIRONMENT: str = "development"

    # -- Database ----------------------------------------------------------
    #: SQLite by default so a clone runs with nothing installed. Postgres is a
    #: configuration change and nothing else:
    #:   postgresql+asyncpg://user:pass@host/dbname
    #: The `+asyncpg` matters - a plain postgresql:// URL fails at startup.
    DATABASE_URL: str = "sqlite+aiosqlite:///./dwi.db"
    DATABASE_URL_SYNC: str = "sqlite:///./dwi.db"

    # -- CORS --------------------------------------------------------------
    #: A comma-separated list of exact origins:
    #:   CORS_ORIGINS=https://myapp.vercel.app,http://localhost:3000
    #: A JSON array is also accepted, because that is what the first version
    #: of this documented and someone's deployment may still be set that way.
    #: `*` is refused: credentials are allowed on these routes, and a wildcard
    #: with credentials is both a security hole and silently ignored by every
    #: browser.
    #: `NoDecode` is load-bearing: without it pydantic-settings tries to
    #: JSON-decode the raw environment value *before* any validator runs, so
    #: a comma-separated list dies with a JSONDecodeError at import time.
    CORS_ORIGINS: Annotated[list[str], NoDecode] = [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ]

    # -- Bounded work ------------------------------------------------------
    #: Ceilings, not targets. Analyze is measured in milliseconds; these exist
    #: so a pathological workflow returns an explained error instead of
    #: holding a connection open forever.
    ANALYZE_TIMEOUT_SECONDS: float = 20.0
    SIMULATE_TIMEOUT_SECONDS: float = 20.0
    OPTIMIZE_TIMEOUT_SECONDS: float = 30.0

    # -- Operations --------------------------------------------------------
    #: Seed both demo domains when the process starts. Idempotent either way;
    #: turn it off if you are pointing at a database you populated yourself.
    SEED_ON_STARTUP: bool = True
    #: Guards POST /admin/reset-seed. **Unset means the endpoint is disabled**,
    #: which is the right default: an unguarded database reset on a public URL
    #: is a stranger's undo button for your demo.
    ADMIN_TOKEN: str = ""

    model_config = {"env_file": ".env", "extra": "ignore"}

    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def _split_origins(cls, value):
        """Accept `a,b,c` as well as `["a","b"]`.

        A comma-separated list is what a hosting dashboard's single-line text
        box is actually good at; quoting a JSON array in one of those is how
        you end up with a deployment that has no CORS at all and a frontend
        that renders an empty page.
        """
        if isinstance(value, str):
            text = value.strip()
            if not text:
                return []
            if text.startswith("["):
                import json

                return json.loads(text)
            return [part.strip() for part in text.split(",") if part.strip()]
        return value

    @field_validator("CORS_ORIGINS", mode="after")
    @classmethod
    def _no_wildcard(cls, value: list[str]) -> list[str]:
        if "*" in value:
            raise ValueError(
                "CORS_ORIGINS cannot be '*': this API allows credentials, and "
                "a wildcard with credentials is rejected by every browser. "
                "List the exact origins instead."
            )
        return value

    @property
    def is_sqlite(self) -> bool:
        return self.DATABASE_URL.startswith("sqlite")

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT.lower() in ("production", "prod")


settings = Settings()
