# Modrinth API for Plugin Management

Use the Modrinth API to retrieve the latest version of a plugin and its download URLs. This is significantly more reliable than web scraping or raw `wget` on some sites.

## Endpoints

- **Latest Version**: `https://api.modrinth.com/v2/project/{project_id}/version`
  - Returns a list of versions. The first entry `[0]` is typically the latest.

## Proven Python Workflow

When using `execute_code`, use this pattern to find the correct JAR for a specific server type:

```python
import requests

def get_latest_jar_url(project_id, loader="spigot"):
    url = f"https://api.modrinth.com/v2/project/{project_id}/version"
    resp = requests.get(url).json()
    # The first version is the latest
    latest_version = resp[0]
    for file in latest_version['files']:
        # Filter for the correct server implementation
        if loader.lower() in file['filename'].lower():
            return file['url']
    return None # Fallback to first file if no match
```

## Common Project IDs
- **ViaVersion**: `P1OZGk5p`
- **Dynmap**: `fRQREgAc`
- **MagicSpells**: `PhyGVafK`
