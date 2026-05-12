# RiverWatch 🎣

Live river conditions and boat ramp access for fishermen — **[river.riktom.com](https://river.riktom.com)**

## Features
- 📍 Auto-locates your position or search by ZIP code
- 🗺️ Map of all USGS stream gauges within your selected radius
- 💧 Real-time gage height, flow rate (CFS), water temperature & turbidity
- 🟢🟡🔴 Color-coded fishing conditions per station
- ⚓ **Boat Ramp & Access Conditions** — every public ramp within radius, color-coded by nearest USGS gauge (green = good, amber = caution, red = likely flooded). Includes surface type, fee, operator, and Google Maps directions.
- 🌊 NOAA tide station markers for coastal rivers
- 📅 7-day NWS weather forecast with fishing tips per station
- 📱 Mobile responsive

## Data Sources
- [USGS National Water Information System](https://waterservices.usgs.gov)
- [NOAA Tides & Currents](https://tidesandcurrents.noaa.gov)
- [National Weather Service](https://api.weather.gov)
- [OpenStreetMap / Overpass API](https://overpass-api.de) — boat ramp locations

## Stack
- Vanilla HTML / CSS / JavaScript
- [Leaflet.js](https://leafletjs.com) with OpenStreetMap tiles
- No API keys required — all public data

## Hosting
Served via nginx on a Hostinger VPS with Let's Encrypt SSL.
