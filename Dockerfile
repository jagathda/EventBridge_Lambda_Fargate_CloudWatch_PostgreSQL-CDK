# Use the official Python image from the DockerHub
FROM python:3.12-slim

# Install required system dependencies for psycopg2
RUN apt-get update && apt-get install -y libpq-dev gcc && \
    pip install psycopg2-binary

# Copy the Python script to the container
COPY message_logger.py /app/message_logger.py

# Set the working directory
WORKDIR /app

# Set the command to run the Python script
CMD ["python", "message_logger.py"]
