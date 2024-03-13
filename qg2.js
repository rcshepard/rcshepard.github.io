"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var initGoogleMapsQuestion = function (id, container, map) {
    var _a;
    // Find the dataBox and hide it
    var dataBox = document.getElementById("QR~" + id);
    if (!dataBox) {
        return new Error("Could not find input for question with id " + id + ".");
    }
    dataBox.style.display = 'none';
    // Find the QuestionBody to append to
    var questionBody = container.querySelector('.QuestionBody') || container;
    // Initialize data storage or load from existing data in field
    var value = dataBox.value !== '' ? JSON.parse(dataBox.value) : {};
    // Function to set the dataBox to a lat/lng
	//i believe this is taking the Google var latLng and making it a string of the value... so here we could instead force the api call
	//we would set value[key] not to latLng but rather add a function to make api call for data string. since it recognizes the var already
	//that means this var is being redefined regularly and updating the value in data box each time the marker moves 
	
    var setLatLng = function (key, latLng) {
		
		async function doAsyncTask() {

var url = "https://maps.googleapis.com/maps/api/geocode/json?latlng=";
var url2 = "&result_type=street_address&key=AIzaSyAttnz_sE_Lg9w9kqRI11ChqQ2mPJPUXkg";
var allurl = url+latLng+url2;
  // var url = (
    // 'https://maps.googleapis.com/maps/api/geocode/json?latlng=?' +latLng+ '&result_type=street_address&key=AIzaSyAttnz_sE_Lg9w9kqRI11ChqQ2mPJPUXkg'
  // );

  var theresult = await fetch(allurl)
    .then(response => response.text());

var resultjson = JSON.parse(theresult);


//console.log(resultjson);
  //console.log(theresult);
}

doAsyncTask();
		
        value[key] = resultjson;
        dataBox.value = JSON.stringify(theresult);
		console.log(dataBox.value);
		//databox value was set to stringify value before, not theresult, but i think this works...
    };
	
  
//GOT TO MAKE THEM CHANGES ABOVE HERE
	
    var styles = document.createElement('style');
    document.head.appendChild(styles);
    // Create the map node
    var mapObject = document.createElement('div');
    mapObject.setAttribute('id', id + "-map");
    if (map.css) {
        styles.innerText += "#" + id + "-map {" + map.css + "}";
        mapObject.setAttribute('style', map.css);
    }
    else {
        styles.innerText += "#" + id + "-map {height: 300px;}";
    }
    questionBody.appendChild(mapObject);
    // Initialize the Google Map
    var googleMap = new google.maps.Map(mapObject, map.options);
    // Initialize the Markers
    (_a = map.markers) === null || _a === void 0 ? void 0 : _a.forEach(function (marker, index) {
        var _a, _b;
        // Create the marker
        var mapMarker = new google.maps.Marker(__assign(__assign({}, marker.options), { map: googleMap, position: index in value ? value[index] : marker.options.position || map.options.center }));
        if ((_a = marker.autocomplete) === null || _a === void 0 ? void 0 : _a.enabled) {
            var inputId = id + "-" + index + "-locationInput";
            // Make the label for the autocomplete
            var locationLabel = document.createElement('label');
            locationLabel.setAttribute('for', inputId);
            locationLabel.setAttribute('id', inputId + "-label");
            locationLabel.setAttribute('class', 'QuestionText');
            if (marker.autocomplete.labelCss) {
                styles.innerText += "#" + inputId + "-label {" + marker.autocomplete.labelCss + "}";
            }
            locationLabel.innerText = marker.autocomplete.label || marker.options.title || "Marker " + (marker.options.label ? marker.options.label : index);
            questionBody.appendChild(locationLabel);
            // Make the autocomplete
            var locationInput = document.createElement('input');
            locationInput.setAttribute('id', inputId);
            locationInput.setAttribute('class', 'InputText');
            if (marker.autocomplete.css) {
                styles.innerText += "#" + id + "-" + index + "-locationInput {" + marker.autocomplete.css + "}";
            }
            questionBody.appendChild(locationInput);
            // Load the places API
            var locationAutocomplete_1 = new google.maps.places.Autocomplete(locationInput);
            // Whenever the inputs change, set the locationLatLong and pan the map to the location
            google.maps.event.addListener(locationAutocomplete_1, 'place_changed', function () {
                var _a;
                var place = locationAutocomplete_1.getPlace();
                if (place.geometry) {
                    mapMarker.setPosition(place.geometry.location);
                    googleMap.panTo(place.geometry.location);
                    setLatLng(index, place.geometry.location);
                }
                else {
                    alert(((_a = marker.autocomplete) === null || _a === void 0 ? void 0 : _a.invalidLocationAlertText) || 'Invalid Location');
                }
            });
        }
        // If there is only one marker, allow setting its position by clicking the map
        var draggableMarkerCount = (_b = map.markers) === null || _b === void 0 ? void 0 : _b.filter(function (marker) { return marker.options.draggable; }).length;
        if (draggableMarkerCount === 1) {
            // When the map is clicked, move the marker and update stored position
            google.maps.event.addListener(googleMap, 'click', function (event) {
                setLatLng(index, event.latLng);
                mapMarker.setPosition(event.latLng);
            });
        }
        // When the marker is dragged, store the lat/lng where it ends
        google.maps.event.addListener(mapMarker, 'dragend', function (event) {
            setLatLng(index, event.latLng);
        });
    });
};
// Typescript doesn't allow augmentation of the global scope except in modules, but we need to expose this to the global scope
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
window.initGoogleMapsQuestion = initGoogleMapsQuestion;
//# sourceMappingURL=QualtricsGoogleMap.js.map