FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && useradd -u 10001 -m telemetry && mkdir /data && chown telemetry /data
COPY . .
USER telemetry
EXPOSE 8556
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8556", "--workers", "1", "--no-proxy-headers", "--no-access-log"]
