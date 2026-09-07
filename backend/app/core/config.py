from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    PROJECT_NAME: str = "Dynamic Workflow Intelligence"
    VERSION: str = "1.0.0"
    ENVIRONMENT: str = "development"

    # Database — defaults to SQLite for local dev, PostgreSQL for production
    DATABASE_URL: str = "sqlite+aiosqlite:///./dwi.db"
    DATABASE_URL_SYNC: str = "sqlite:///./dwi.db"

    # CORS
    CORS_ORIGINS: list[str] = ["http://localhost:3000", "http://127.0.0.1:3000"]

    model_config = {"env_file": ".env", "extra": "ignore"}


settings = Settings()
