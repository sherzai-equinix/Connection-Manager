FROM python:3.11-slim AS backend

WORKDIR /app

# System deps for psycopg2-binary
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py config.py database.py models.py security.py audit.py crud.py ./
COPY routers/ routers/
COPY scripts/ scripts/
COPY migrations/ migrations/
COPY frontend/ frontend/

EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2", "--proxy-headers"]
