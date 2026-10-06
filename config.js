// Google Maps JavaScript API key. Leave empty to use the free OpenStreetMap base map instead.
// Get one at https://console.cloud.google.com/google/maps-apis and restrict it to this site's domain.
window.FLOOD_CONFIG = {
  GOOGLE_MAPS_API_KEY: 'AIzaSyAPUs5VZOOHQv_86fT5jkCoErU7Wzih1e8',
  WARN_METERS: 300,        // warn when you are this close to a flooded road
  REFRESH_MINUTES: 5,      // how often an open page re-checks for new data
  STALE_MINUTES: 45,       // show a warning when the newest sensor reading is older than this
  POINT_RADIUS_M: 150,     // size of the circle drawn for a sensor whose road could not be found
  // Built every 10 minutes by .github/workflows/update-flood.yml and published to the `data` branch.
  DATA_URL: 'https://raw.githubusercontent.com/LupangSyS/Flood/data/flood.geojson',
  FALLBACK_URL: 'data/flood.geojson',   // copy shipped with the site, used if the live file cannot be loaded
};
