from fastapi import FastAPI

from app.services import payments

app = FastAPI()


@app.post("/checkout")
def checkout(amount: int):
    return payments.create_intent(amount)
