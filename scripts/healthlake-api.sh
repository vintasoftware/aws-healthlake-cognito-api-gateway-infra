#!/bin/bash

set -e

# Check if required parameters are provided
if [ "$#" -lt 3 ]; then
    echo "Usage: $0 <api-url> <user-pool-id> <client-id>"
    echo "Example: $0 https://abcdef123.execute-api.us-east-1.amazonaws.com/prod/ us-east-1_abcdefg 1abc2defghij3klmno4pqr5st"
    exit 1
fi

API_URL=$1
USER_POOL_ID=$2
CLIENT_ID=$3
REGION=$(echo $USER_POOL_ID | cut -d'_' -f1)
COGNITO_URL="https://cognito-idp.${REGION}.amazonaws.com/"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to sign up a new user
signup() {
    echo -e "${YELLOW}Signing up a new user...${NC}"
    
    read -p "Email: " EMAIL
    read -p "Password (must include uppercase, lowercase, number, and special character): " -s PASSWORD
    echo
    read -p "First Name: " FIRST_NAME
    read -p "Last Name: " LAST_NAME
    
    # Create JSON payload for signup
    SIGNUP_PAYLOAD='{
        "ClientId": "'"$CLIENT_ID"'",
        "Username": "'"$EMAIL"'",
        "Password": "'"$PASSWORD"'", 
        "UserAttributes": [
            {
                "Name": "email",
                "Value": "'"$EMAIL"'"
            },
            {
                "Name": "given_name",
                "Value": "'"$FIRST_NAME"'"
            },
            {
                "Name": "family_name",
                "Value": "'"$LAST_NAME"'"
            }
        ]
    }'
    
    # Call Cognito API to sign up
    SIGNUP_RESPONSE=$(curl -s -X POST \
        -H "X-Amz-Target: AWSCognitoIdentityProviderService.SignUp" \
        -H "Content-Type: application/x-amz-json-1.1" \
        -d "$SIGNUP_PAYLOAD" \
        "$COGNITO_URL")
    
    # Check for errors
    if echo "$SIGNUP_RESPONSE" | grep -q "message"; then
        ERROR_MSG=$(echo "$SIGNUP_RESPONSE" | grep -o '"message":"[^"]*"' | cut -d'"' -f4)
        echo -e "${RED}Error: $ERROR_MSG${NC}"
        return 1
    fi
    
    echo -e "${GREEN}User signed up successfully!${NC}"
    echo -e "${YELLOW}Check your email for a verification code.${NC}"
    
    # Confirm signup with verification code
    read -p "Enter verification code from email: " VERIFICATION_CODE
    
    CONFIRM_PAYLOAD='{
        "ClientId": "'"$CLIENT_ID"'",
        "Username": "'"$EMAIL"'",
        "ConfirmationCode": "'"$VERIFICATION_CODE"'"
    }'
    
    CONFIRM_RESPONSE=$(curl -s -X POST \
        -H "X-Amz-Target: AWSCognitoIdentityProviderService.ConfirmSignUp" \
        -H "Content-Type: application/x-amz-json-1.1" \
        -d "$CONFIRM_PAYLOAD" \
        "$COGNITO_URL")
    
    # Check for errors
    if echo "$CONFIRM_RESPONSE" | grep -q "message"; then
        ERROR_MSG=$(echo "$CONFIRM_RESPONSE" | grep -o '"message":"[^"]*"' | cut -d'"' -f4)
        echo -e "${RED}Error: $ERROR_MSG${NC}"
        return 1
    fi
    
    echo -e "${GREEN}Email verification successful!${NC}"
    return 0
}

# Function to log in a user
login() {
    echo -e "${YELLOW}Logging in...${NC}"
    
    read -p "Email: " EMAIL
    read -p "Password: " -s PASSWORD
    echo
    
    # Create JSON payload for login
    LOGIN_PAYLOAD='{
        "AuthFlow": "USER_PASSWORD_AUTH",
        "ClientId": "'"$CLIENT_ID"'",
        "AuthParameters": {
            "USERNAME": "'"$EMAIL"'",
            "PASSWORD": "'"$PASSWORD"'"
        }
    }'
    
    # Call Cognito API to log in
    LOGIN_RESPONSE=$(curl -s -X POST \
        -H "X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth" \
        -H "Content-Type: application/x-amz-json-1.1" \
        -d "$LOGIN_PAYLOAD" \
        "$COGNITO_URL")
    
    # Check for errors
    if echo "$LOGIN_RESPONSE" | grep -q "message"; then
        ERROR_MSG=$(echo "$LOGIN_RESPONSE" | grep -o '"message":"[^"]*"' | cut -d'"' -f4)
        echo -e "${RED}Error: $ERROR_MSG${NC}"
        return 1
    fi
    
    # Extract tokens
    ID_TOKEN=$(echo "$LOGIN_RESPONSE" | grep -o '"IdToken":"[^"]*"' | cut -d'"' -f4)
    ACCESS_TOKEN=$(echo "$LOGIN_RESPONSE" | grep -o '"AccessToken":"[^"]*"' | cut -d'"' -f4)
    REFRESH_TOKEN=$(echo "$LOGIN_RESPONSE" | grep -o '"RefreshToken":"[^"]*"' | cut -d'"' -f4)
    
    # Save tokens to file
    echo "$ID_TOKEN" > ~/.healthlake_id_token
    echo "$ACCESS_TOKEN" > ~/.healthlake_access_token
    echo "$REFRESH_TOKEN" > ~/.healthlake_refresh_token
    
    echo -e "${GREEN}Login successful! Tokens saved.${NC}"
    return 0
}

# Function to list patients
list_patients() {
    echo -e "${YELLOW}Listing patients...${NC}"
    
    # Check if access token exists
    if [ ! -f ~/.healthlake_access_token ]; then
        echo -e "${RED}Not logged in. Please login first.${NC}"
        return 1
    fi
    
    ACCESS_TOKEN=$(cat ~/.healthlake_access_token)
    
    # Call HealthLake API to list patients
    PATIENT_RESPONSE=$(curl -X GET \
        -H "Authorization: Bearer $ACCESS_TOKEN" \
        "${API_URL}healthlake/Patient")
    
    # Check for errors
    if echo "$PATIENT_RESPONSE" | grep -q "message\|errorType\|error"; then
        echo -e "${RED}Error fetching patients:${NC}"
        if command -v jq &> /dev/null; then
            echo "$PATIENT_RESPONSE" | jq '.'
        else
            echo "$PATIENT_RESPONSE"
        fi
        return 1
    fi
    
    # Format and display results using jq if available
    echo -e "${GREEN}Patients:${NC}"
    if command -v jq &> /dev/null; then
        echo "$PATIENT_RESPONSE" | jq -r '.entry[]?.resource | "ID: \(.id) - Name: \(.name[]?.given[]?) \(.name[]?.family) - Gender: \(.gender) - Birth Date: \(.birthDate)"'
    else
        echo "$PATIENT_RESPONSE"
    fi
    
    return 0
}

# Function to create a new patient
create_patient() {
    echo -e "${YELLOW}Creating a new patient...${NC}"
    
    # Check if access token exists
    if [ ! -f ~/.healthlake_access_token ]; then
        echo -e "${RED}Not logged in. Please login first.${NC}"
        return 1
    fi
    
    ACCESS_TOKEN=$(cat ~/.healthlake_access_token)
    
    # Collect patient information
    read -p "Given Name: " GIVEN_NAME
    read -p "Family Name: " FAMILY_NAME
    read -p "Gender (male/female/other/unknown): " GENDER
    read -p "Birth Date (YYYY-MM-DD): " BIRTH_DATE
    
    # Create JSON payload for patient creation - ensuring it matches FHIR R4 format
    PATIENT_PAYLOAD='{
        "resourceType": "Patient",
        "name": [
            {
                "use": "official",
                "given": ["'"$GIVEN_NAME"'"],
                "family": "'"$FAMILY_NAME"'"
            }
        ],
        "gender": "'"$GENDER"'",
        "birthDate": "'"$BIRTH_DATE"'"
    }'
    
    # Call HealthLake API to create patient with verbose output for debugging
    echo -e "${YELLOW}Sending request to create patient...${NC}"
    
    # Make the API call
    PATIENT_RESPONSE=$(curl -s -X POST \
        -H "Authorization: Bearer $ACCESS_TOKEN" \
        -H "Content-Type: application/fhir+json" \
        -d "$PATIENT_PAYLOAD" \
        "${API_URL}healthlake/Patient")

    # Try to format with jq if available
    if command -v jq &> /dev/null; then
        if echo "$PATIENT_RESPONSE" | jq '.' &>/dev/null; then
            echo -e "${BLUE}Response:${NC}"
            echo "$PATIENT_RESPONSE" | jq '.'
        else
            echo -e "${BLUE}Response (not valid JSON):${NC}"
            echo "$PATIENT_RESPONSE"
        fi
    else
        echo -e "${BLUE}Response:${NC}"
        echo "$PATIENT_RESPONSE"
    fi
    
    # Check for errors
    if echo "$PATIENT_RESPONSE" | grep -q "message\|errorType\|error"; then
        echo -e "${RED}Error creating patient.${NC}"
        return 1
    fi
    
    # Extract and display the new patient ID if response is valid JSON
    if command -v jq &> /dev/null && echo "$PATIENT_RESPONSE" | jq '.' &>/dev/null; then
        PATIENT_ID=$(echo "$PATIENT_RESPONSE" | jq -r '.id // "Unknown"')
        if [ "$PATIENT_ID" != "Unknown" ] && [ "$PATIENT_ID" != "null" ]; then
            echo -e "${GREEN}Patient created successfully!${NC}"
            echo -e "Patient ID: ${YELLOW}$PATIENT_ID${NC}"
        else
            echo -e "${YELLOW}Patient may have been created, but couldn't extract ID from response.${NC}"
        fi
    else
        echo -e "${YELLOW}Could not parse response as JSON.${NC}"
    fi
    
    return 0
}

# Function to get a specific patient by ID
get_patient() {
    echo -e "${YELLOW}Getting patient details...${NC}"
    
    # Check if access token exists
    if [ ! -f ~/.healthlake_access_token ]; then
        echo -e "${RED}Not logged in. Please login first.${NC}"
        return 1
    fi
    
    ACCESS_TOKEN=$(cat ~/.healthlake_access_token)
    
    # Get patient ID
    read -p "Enter Patient ID: " PATIENT_ID
    
    # Call HealthLake API to get patient
    PATIENT_RESPONSE=$(curl -s -X GET \
        -H "Authorization: Bearer $ACCESS_TOKEN" \
        "${API_URL}healthlake/Patient/$PATIENT_ID")
    
    # Check for errors
    if echo "$PATIENT_RESPONSE" | grep -q "message\|errorType\|error"; then
        echo -e "${RED}Error fetching patient:${NC}"
        if command -v jq &> /dev/null; then
            echo "$PATIENT_RESPONSE" | jq '.'
        else
            echo "$PATIENT_RESPONSE"
        fi
        return 1
    fi
    
    # Format and display results
    echo -e "${GREEN}Patient Details:${NC}"
    if command -v jq &> /dev/null; then
        echo "$PATIENT_RESPONSE" | jq '.'
    else
        echo "$PATIENT_RESPONSE"
    fi
    
    return 0
}

# Function to create an observation for a patient
create_observation() {
    echo -e "${YELLOW}Creating a new observation...${NC}"
    
    # Check if access token exists
    if [ ! -f ~/.healthlake_access_token ]; then
        echo -e "${RED}Not logged in. Please login first.${NC}"
        return 1
    fi
    
    ACCESS_TOKEN=$(cat ~/.healthlake_access_token)
    
    # Collect observation information
    read -p "Patient ID: " PATIENT_ID
    read -p "Observation Type (e.g., heart-rate, blood-pressure): " OBS_TYPE
    read -p "Observation Value: " OBS_VALUE
    read -p "Unit (e.g., bpm, mmHg): " OBS_UNIT
    
    # Get current date in FHIR format
    EFFECTIVE_DATE=$(date -u +"%Y-%m-%d")
    
    # Create JSON payload for observation
    OBSERVATION_PAYLOAD='{
        "resourceType": "Observation",
        "status": "final",
        "code": {
            "coding": [
                {
                    "system": "http://terminology.hl7.org/CodeSystem/observation-category",
                    "code": "'"$OBS_TYPE"'",
                    "display": "'"$OBS_TYPE"'"
                }
            ]
        },
        "subject": {
            "reference": "Patient/'"$PATIENT_ID"'"
        },
        "effectiveDateTime": "'"$EFFECTIVE_DATE"'",
        "valueQuantity": {
            "value": '"$OBS_VALUE"',
            "unit": "'"$OBS_UNIT"'",
            "system": "http://unitsofmeasure.org",
            "code": "'"$OBS_UNIT"'"
        }
    }'
    
    # Call HealthLake API to create observation
    OBSERVATION_RESPONSE=$(curl -s -X POST \
        -H "Authorization: Bearer $ACCESS_TOKEN" \
        -H "Content-Type: application/fhir+json" \
        -d "$OBSERVATION_PAYLOAD" \
        "${API_URL}healthlake/Observation")
    
    # Format and display response
    if command -v jq &> /dev/null; then
        if echo "$OBSERVATION_RESPONSE" | jq '.' &>/dev/null; then
            echo -e "${BLUE}Response:${NC}"
            echo "$OBSERVATION_RESPONSE" | jq '.'
        else
            echo -e "${BLUE}Response (not valid JSON):${NC}"
            echo "$OBSERVATION_RESPONSE"
        fi
    else
        echo -e "${BLUE}Response:${NC}"
        echo "$OBSERVATION_RESPONSE"
    fi
    
    # Check for errors
    if echo "$OBSERVATION_RESPONSE" | grep -q "message\|errorType\|error"; then
        echo -e "${RED}Error creating observation.${NC}"
        return 1
    fi
    
    # Extract and display the new observation ID
    if command -v jq &> /dev/null && echo "$OBSERVATION_RESPONSE" | jq '.' &>/dev/null; then
        OBSERVATION_ID=$(echo "$OBSERVATION_RESPONSE" | jq -r '.id // "Unknown"')
        if [ "$OBSERVATION_ID" != "Unknown" ] && [ "$OBSERVATION_ID" != "null" ]; then
            echo -e "${GREEN}Observation created successfully!${NC}"
            echo -e "Observation ID: ${YELLOW}$OBSERVATION_ID${NC}"
        else
            echo -e "${YELLOW}Observation may have been created, but couldn't extract ID from response.${NC}"
        fi
    else
        echo -e "${YELLOW}Could not parse response as JSON.${NC}"
    fi
    
    return 0
}

# Function to list observations for a patient
list_observations() {
    echo -e "${YELLOW}Listing observations for a patient...${NC}"
    
    # Check if access token exists
    if [ ! -f ~/.healthlake_access_token ]; then
        echo -e "${RED}Not logged in. Please login first.${NC}"
        return 1
    fi
    
    ACCESS_TOKEN=$(cat ~/.healthlake_access_token)
    
    # Get patient ID
    read -p "Enter Patient ID: " PATIENT_ID
    
    # Call HealthLake API to list observations
    OBSERVATION_RESPONSE=$(curl -s -X GET \
        -H "Authorization: Bearer $ACCESS_TOKEN" \
        "${API_URL}healthlake/Observation?subject=Patient/$PATIENT_ID")
    
    # Check for errors
    if echo "$OBSERVATION_RESPONSE" | grep -q "message\|errorType\|error"; then
        echo -e "${RED}Error fetching observations:${NC}"
        if command -v jq &> /dev/null; then
            echo "$OBSERVATION_RESPONSE" | jq '.'
        else
            echo "$OBSERVATION_RESPONSE"
        fi
        return 1
    fi
    
    # Format and display results
    echo -e "${GREEN}Observations for Patient $PATIENT_ID:${NC}"
    if command -v jq &> /dev/null; then
        echo "$OBSERVATION_RESPONSE" | jq -r '.entry[]?.resource | "ID: \(.id) - Type: \(.code.coding[0].display) - Value: \(.valueQuantity.value) \(.valueQuantity.unit) - Date: \(.effectiveDateTime)"'
    else
        echo "$OBSERVATION_RESPONSE"
    fi
    
    return 0
}

# Main menu
while true; do
    echo -e "\n${YELLOW}===== HealthLake API Client =====${NC}"
    echo "1. Sign up"
    echo "2. Log in"
    echo "3. List patients"
    echo "4. Create patient"
    echo "5. Get patient by ID"
    echo "6. Create observation"
    echo "7. List observations for a patient"
    echo "8. Exit"
    read -p "Choose an option (1-8): " OPTION
    
    case $OPTION in
        1) signup ;;
        2) login ;;
        3) list_patients ;;
        4) create_patient ;;
        5) get_patient ;;
        6) create_observation ;;
        7) list_observations ;;
        8) echo -e "${GREEN}Goodbye!${NC}"; exit 0 ;;
        *) echo -e "${RED}Invalid option. Please try again.${NC}" ;;
    esac
done
