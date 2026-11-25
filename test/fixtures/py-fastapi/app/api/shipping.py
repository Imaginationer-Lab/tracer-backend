import os

import requests

SHIPPING_API = os.environ["SHIPPING_API_URL"]


def get_quote(zip_code: str):
    return requests.get(f"{SHIPPING_API}/quotes", params={"zip": zip_code}, timeout=3).json()
