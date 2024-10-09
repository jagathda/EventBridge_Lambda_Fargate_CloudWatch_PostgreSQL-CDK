import os
import logging
import psycopg2
from psycopg2 import sql

# Set up logging
logging.basicConfig(level=logging.INFO)

# Retrieve environment variables
event_payload = os.getenv('EVENT_PAYLOAD', 'default_payload')
event_type = os.getenv('EVENT_TYPE', 'Unknown')

# Log to CloudWatch
logging.info(f"EVENT_PAYLOAD: {event_payload}")
logging.info(f"EVENT_TYPE: {event_type}")

# PostgreSQL connection details
pg_host = os.getenv('PG_HOST')
pg_user = os.getenv('PG_USER')
pg_password = os.getenv('PG_PASSWORD')
pg_db = os.getenv('PG_DB')
pg_port = os.getenv('PG_PORT', 5432)

# Connect to PostgreSQL and log the event
conn = None

def create_table_if_not_exists(cursor):
    """Create the events_log table if it doesn't exist."""
    create_table_query = '''
    CREATE TABLE IF NOT EXISTS events_log (
        id SERIAL PRIMARY KEY,
        event_payload JSONB NOT NULL,
        event_type VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    '''
    cursor.execute(create_table_query)

try:
    conn = psycopg2.connect(
        host=pg_host,
        user=pg_user,
        password=pg_password,
        dbname=pg_db,
        port=pg_port
    )
    cursor = conn.cursor()
    
    # Create table if it doesn't exist
    create_table_if_not_exists(cursor)
    
    # Insert event data into PostgreSQL
    insert_query = sql.SQL("INSERT INTO events_log (event_payload, event_type) VALUES (%s, %s)")
    cursor.execute(insert_query, (event_payload, event_type))
    
    # Commit the transaction
    conn.commit()
    logging.info('Event successfully logged to PostgreSQL')
    
except Exception as e:
    logging.error(f"Error logging event to PostgreSQL: {e}")
    
finally:
    if conn:
        cursor.close()
        conn.close()
