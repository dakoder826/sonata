FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# ffmpeg is required by yt-dlp audio post-processing.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps in a separate layer for better cache reuse.
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Copy app code last so code-only changes don't invalidate dependency layer.
COPY main.py /app/main.py

EXPOSE 8080

CMD ["python", "-c", "import os, uvicorn; uvicorn.run('main:app', host='0.0.0.0', port=int(os.environ.get('PORT', '8080')))"]