FROM python:3.11-slim-bookworm

LABEL maintainer="carandev"
LABEL description="Calibre-Web with Reading Progress Sync"

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV CALIBRE_DBPATH=/config
ENV TZ=America/Bogota

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libldap2-dev \
    libsasl2-dev \
    libmagic1 \
    imagemagick \
    ghostscript \
    libxml2-dev \
    libxslt1-dev \
    zlib1g-dev \
    libjpeg-dev \
    libpng-dev \
    libffi-dev \
    && rm -rf /var/lib/apt/lists/*

# Create app user
RUN groupadd -g 1000 calibre && \
    useradd -u 1000 -g calibre -d /app -s /bin/bash calibre

# Set working directory
WORKDIR /app

# Copy requirements first for better caching
COPY requirements.txt optional-requirements.txt ./

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt && \
    pip install --no-cache-dir -r optional-requirements.txt || true

# Copy application code
COPY --chown=calibre:calibre . .

# Create directories for config and books
RUN mkdir -p /config /books && \
    chown -R calibre:calibre /config /books

# Switch to non-root user
USER calibre

# Expose port
EXPOSE 8083

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8083/opds')" || exit 1

# Start application
CMD ["python", "cps.py"]
