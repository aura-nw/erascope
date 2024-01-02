# Horoscope handler

## Subquery, The Graph

Both The Graph and Subquery are open-source data indexer and provide GraphQL to query data that is difficult to query directly onchain. They have their SDK for each type network (Ethereum, Polygon, Arbitrum, Cosmos, etc...). Each package almost follow their rules and allow developer customize with 4 function:

- blockHandler
- txHandler
- messageHandler
- eventHandler

Their main flow:

```mermaid
  sequenceDiagram
  autonumber
  participant A as Network
  participant B as SubQuery/TheGraph
  participant C as CustomLogic
  participant D as Database

  loop Interval
    activate B
    B->>A: Get block
    activate A
    A-->>B: Return block
    deactivate A

    B->>C: Call blockHandler function
    activate C
    C->>C: Handle Custom Logic in blockHandler
    C->>D: Save data to Database
    D-->>C: Save success
    C-->>B: Return success
    deactivate C
    deactivate B

    activate B
    B->>A: Get all tx in block
    activate A
    A-->>B: Return Txs
    deactivate A
    B->>B: Decode all tx

    loop all txs in block
      B->>C: Call txHandler function
      activate C
      C->>C: Handler Custom Logic in txHandler
      C->>D: Save data to Database
      D-->>C: Save success
      C-->>B: Return success
      deactivate C
    end
    deactivate B

    activate B
    loop all messages in tx
      B->>C: Call messageHandler function
      activate C
      C-->>C: Handle Custom Logic in messageHandler
      C->>D: Save data to Database
      D-->>C: Save success
      deactivate C
      C-->>B: Return success
    end
    deactivate B

    activate B
    loop all events in messages
      B->>C: Call eventHandler function
      activate C
        C->>C: Handle Custom Logic in eventHandler
        C->>D: Save data to Database
        D-->>C: Save success
        C-->>B: Return success
      deactivate C
    end
    deactivate B
  end
```
