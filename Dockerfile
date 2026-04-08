FROM python:3.11-slim

WORKDIR /app

# System deps (oft nötig für psycopg2 / builds)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Wenn du uvicorn/fastapi nutzt -> 8000. Wenn flask -> oft 5000.
EXPOSE 8000

# Default: versuche uvicorn (passt bei vielen setups)
CMD ["python", "app.py"]
