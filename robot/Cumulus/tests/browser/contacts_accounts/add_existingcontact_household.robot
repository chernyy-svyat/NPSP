*** Settings ***

Resource        robot/Cumulus/resources/NPSP.robot
Library         cumulusci.robotframework.PageObjects
...             robot/Cumulus/resources/ContactPageObject.py
...             robot/Cumulus/resources/NPSP.py
Suite Setup     Open Test Browser
Suite Teardown  Delete Records and Close Browser

*** Test Cases ***

Add Existing Contact to Existing Household 
    [Documentation]                      Create 2 contacts with API which inturn creates 2 household accounts.
    ...                                  Open contact2 record and change the account name to contact1 account
    ...                                  verify that both the contacts are now showing under contact1 account
    #Create two contacts 
    &{contact1} =                        API Create Contact    Email=automation@robot.com
    &{contact2} =                        API Create Contact
    Go To Page                           Details               Contact                                object_id=&{contact2}[Id]
    Edit Record
    
    #Update account on contact2 and Save
    Update Field Value                   Account Name          &{contact2}[LastName] Household        &{contact1}[LastName] Household
    Save Form
    
    #Verify both contacts are displayed under household account1
    Click Header Field Link              Account Name
    Save Session Record For Deletion     Account
    Select Tab                           Related
    Verify Related List Items            Contacts              &{contact1}[FirstName] &{contact1}[LastName]
    Verify Related List Items            Contacts              &{contact2}[FirstName] &{contact2}[LastName]
