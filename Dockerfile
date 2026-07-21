FROM python:3.12-slim
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY watcher.py .
COPY index.html .
EXPOSE 8085
CMD ["python", "watcher.py"]
